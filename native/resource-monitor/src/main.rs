use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{self, BufRead, BufWriter, Write};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use sysinfo::{
    MINIMUM_CPU_UPDATE_INTERVAL, Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind,
};

const PROTOCOL_VERSION: u32 = 3;
const MIN_SAMPLE_INTERVAL_MS: u64 = 250;
const MAX_SAMPLE_INTERVAL_MS: u64 = 60_000;
const PROCESS_START_TIME_PRECISION_MS: u64 = 1_000;
const HISTORY_RETENTION_MS: u64 = 60 * 60_000;
const MAX_HISTORY_SNAPSHOTS: usize = 3_600;
const INPUT_QUEUE_CAPACITY: usize = 64;
const MAX_HISTORY_RETAINED_ENTRIES: usize = 20_000;
const MAX_HISTORY_RETAINED_BYTES: usize = 64 * 1024 * 1024;
const MAX_PROCESS_NAME_BYTES: usize = 1_024;
const MAX_PROCESS_COMMAND_BYTES: usize = 16 * 1_024;
const MAX_PROCESS_STATUS_BYTES: usize = 256;
const HISTORY_CHUNK_SNAPSHOTS: usize = 32;
const TWO_STAGE_PROCESS_REFRESH: bool = cfg!(any(target_os = "linux", target_os = "macos"));

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExternalProcess {
    pid: u32,
    #[serde(default)]
    start_time_ms: Option<u64>,
}

impl ExternalProcess {
    fn estimated_history_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
    }
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum Command {
    Configure {
        version: u32,
        root_pid: u32,
        sample_interval_ms: u64,
        #[serde(default)]
        external_processes: Vec<ExternalProcess>,
    },
    SetExternalProcesses {
        version: u32,
        processes: Vec<ExternalProcess>,
    },
    SetSampleInterval {
        version: u32,
        sample_interval_ms: u64,
    },
    SetStreaming {
        version: u32,
        enabled: bool,
    },
    SampleNow {
        version: u32,
        request_id: String,
    },
    ProcessTable {
        version: u32,
        request_id: String,
    },
    ReadHistory {
        version: u32,
        request_id: String,
        window_ms: u64,
    },
    Shutdown {
        version: u32,
    },
}

impl Command {
    fn version(&self) -> u32 {
        match self {
            Self::Configure { version, .. }
            | Self::SetExternalProcesses { version, .. }
            | Self::SetSampleInterval { version, .. }
            | Self::SetStreaming { version, .. }
            | Self::SampleNow { version, .. }
            | Self::ProcessTable { version, .. }
            | Self::ReadHistory { version, .. }
            | Self::Shutdown { version } => *version,
        }
    }
}

enum Input {
    Command(Command),
    Invalid(String),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Capabilities {
    cumulative_cpu_time: bool,
    current_cpu_percent: bool,
    resident_memory: bool,
    virtual_memory: bool,
    io_bytes: bool,
    process_start_time: bool,
    process_tree: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HelloEvent {
    version: u32,
    #[serde(rename = "type")]
    event_type: &'static str,
    sidecar_version: &'static str,
    sidecar_pid: u32,
    platform: &'static str,
    arch: &'static str,
    capabilities: Capabilities,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
enum IoSemantics {
    Storage,
    AllIo,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessSample {
    pid: u32,
    ppid: u32,
    start_time_ms: u64,
    run_time_ms: u64,
    name: String,
    command: String,
    status: String,
    cpu_percent: f32,
    cpu_time_ms: u64,
    resident_bytes: u64,
    virtual_bytes: u64,
    io_read_bytes: u64,
    io_write_bytes: u64,
    io_semantics: IoSemantics,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessTableEntry {
    pid: u32,
    ppid: u32,
    name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessTableEvent<'a> {
    version: u32,
    #[serde(rename = "type")]
    event_type: &'static str,
    request_id: &'a str,
    processes: Vec<ProcessTableEntry>,
}

impl ProcessSample {
    fn estimated_history_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            .saturating_add(self.name.len())
            .saturating_add(self.command.len())
            .saturating_add(self.status.len())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotEvent {
    version: u32,
    #[serde(rename = "type")]
    event_type: &'static str,
    sequence: u64,
    sampled_at_unix_ms: u64,
    collection_duration_micros: u64,
    scanned_process_count: usize,
    retained_process_count: usize,
    inaccessible_process_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
    external_processes: Vec<ExternalProcess>,
    processes: Vec<ProcessSample>,
}

impl SnapshotEvent {
    fn retained_entry_count(&self) -> usize {
        self.processes
            .len()
            .saturating_add(self.external_processes.len())
    }

    fn estimated_history_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            .saturating_add(
                self.processes
                    .iter()
                    .map(ProcessSample::estimated_history_bytes)
                    .sum::<usize>(),
            )
            .saturating_add(
                self.external_processes
                    .iter()
                    .map(ExternalProcess::estimated_history_bytes)
                    .sum::<usize>(),
            )
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryChunkEvent<'a> {
    version: u32,
    #[serde(rename = "type")]
    event_type: &'static str,
    request_id: &'a str,
    done: bool,
    snapshots: &'a [SnapshotEvent],
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorEvent {
    version: u32,
    #[serde(rename = "type")]
    event_type: &'static str,
    code: &'static str,
    message: String,
    recoverable: bool,
}

#[derive(Debug, Clone)]
struct CollectorConfig {
    root_pid: u32,
    sample_interval: Option<Duration>,
    external_processes: HashMap<u32, Option<u64>>,
}

#[derive(Default)]
struct HistoryRecorder {
    snapshots: VecDeque<SnapshotEvent>,
    retained_entry_count: usize,
    retained_bytes: usize,
}

impl HistoryRecorder {
    fn record(&mut self, snapshot: &SnapshotEvent) {
        self.record_with_limits(
            snapshot,
            MAX_HISTORY_SNAPSHOTS,
            MAX_HISTORY_RETAINED_ENTRIES,
            MAX_HISTORY_RETAINED_BYTES,
        );
    }

    fn record_with_limits(
        &mut self,
        snapshot: &SnapshotEvent,
        max_snapshots: usize,
        max_retained_entries: usize,
        max_retained_bytes: usize,
    ) {
        let clock_moved_backward = self
            .snapshots
            .back()
            .is_some_and(|previous| previous.sampled_at_unix_ms > snapshot.sampled_at_unix_ms);
        let mut retained = snapshot.clone();
        retained.request_id = None;
        self.retained_entry_count = self
            .retained_entry_count
            .saturating_add(retained.retained_entry_count());
        self.retained_bytes = self
            .retained_bytes
            .saturating_add(retained.estimated_history_bytes());
        self.snapshots.push_back(retained);
        self.trim_to_limits(
            snapshot.sampled_at_unix_ms,
            max_snapshots,
            max_retained_entries,
            max_retained_bytes,
            clock_moved_backward,
        );
    }

    fn trim_to_limits(
        &mut self,
        now_ms: u64,
        max_snapshots: usize,
        max_retained_entries: usize,
        max_retained_bytes: usize,
        clock_moved_backward: bool,
    ) {
        if clock_moved_backward {
            let mut future_entry_count = 0usize;
            let mut future_bytes = 0usize;
            self.snapshots.retain(|snapshot| {
                let keep = snapshot.sampled_at_unix_ms <= now_ms;
                if !keep {
                    future_entry_count =
                        future_entry_count.saturating_add(snapshot.retained_entry_count());
                    future_bytes = future_bytes.saturating_add(snapshot.estimated_history_bytes());
                }
                keep
            });
            self.retained_entry_count =
                self.retained_entry_count.saturating_sub(future_entry_count);
            self.retained_bytes = self.retained_bytes.saturating_sub(future_bytes);
        }

        while self.snapshots.front().is_some_and(|snapshot| {
            snapshot.sampled_at_unix_ms < now_ms.saturating_sub(HISTORY_RETENTION_MS)
                || self.snapshots.len() > max_snapshots
                || self.retained_entry_count > max_retained_entries
                || self.retained_bytes > max_retained_bytes
        }) {
            if let Some(removed) = self.snapshots.pop_front() {
                self.retained_entry_count = self
                    .retained_entry_count
                    .saturating_sub(removed.retained_entry_count());
                self.retained_bytes = self
                    .retained_bytes
                    .saturating_sub(removed.estimated_history_bytes());
            }
        }
    }

    fn read(&self, window_ms: u64, now_ms: u64) -> Vec<SnapshotEvent> {
        let started_at_ms = now_ms.saturating_sub(window_ms.min(HISTORY_RETENTION_MS));
        self.snapshots
            .iter()
            .filter(|snapshot| {
                snapshot.sampled_at_unix_ms >= started_at_ms
                    && snapshot.sampled_at_unix_ms <= now_ms
            })
            .cloned()
            .collect()
    }
}

struct Collector {
    system: System,
    sequence: u64,
    cpu_baseline_refreshed_at: Option<Instant>,
}

impl Collector {
    fn new() -> Self {
        Self {
            system: System::new(),
            sequence: 0,
            cpu_baseline_refreshed_at: None,
        }
    }

    fn prime_cpu_usage(&mut self) {
        self.system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            process_discovery_refresh_kind(),
        );
        self.cpu_baseline_refreshed_at = Some(Instant::now());
    }

    fn process_table(&self) -> Vec<ProcessTableEntry> {
        // A separate System preserves snapshot CPU baselines.
        let mut process_table_system = System::new();
        process_table_system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().without_tasks(),
        );
        let mut processes = process_table_system
            .processes()
            .iter()
            .filter_map(|(pid, process)| {
                let pid = pid.as_u32();
                // Kernel idle PID 0 would fail the server's positive-PID event schema.
                if pid == 0 {
                    return None;
                }
                Some(ProcessTableEntry {
                    pid,
                    ppid: process.parent().map(Pid::as_u32).unwrap_or(0),
                    name: truncate_utf8(
                        process.name().to_string_lossy().into_owned(),
                        MAX_PROCESS_NAME_BYTES,
                    ),
                })
            })
            .collect::<Vec<_>>();
        processes.sort_by_key(|process| process.pid);
        processes
    }

    fn sample(&mut self, config: &CollectorConfig, request_id: Option<String>) -> SnapshotEvent {
        if let Some(delay) =
            remaining_cpu_measurement_delay(self.cpu_baseline_refreshed_at.take(), Instant::now())
        {
            thread::sleep(delay);
        }
        let collection_started = Instant::now();
        self.system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            process_discovery_refresh_kind(),
        );
        self.cpu_baseline_refreshed_at = Some(Instant::now());

        let rows = self
            .system
            .processes()
            .iter()
            .map(|(pid, process)| {
                let pid = pid.as_u32();
                let ppid = process.parent().map(Pid::as_u32).unwrap_or(0);
                (pid, ppid, process.start_time().saturating_mul(1_000))
            })
            .collect::<Vec<_>>();
        let external_processes = config
            .external_processes
            .iter()
            .filter_map(|(pid, expected_start_time_ms)| {
                let (_, _, actual_start_time_ms) = rows
                    .iter()
                    .find(|(candidate_pid, _, _)| candidate_pid == pid)?;
                matches_external_identity(*actual_start_time_ms, *expected_start_time_ms).then_some(
                    ExternalProcess {
                        pid: *pid,
                        start_time_ms: Some(*actual_start_time_ms),
                    },
                )
            })
            .collect::<Vec<_>>();
        let mut roots = external_processes
            .iter()
            .map(|process| process.pid)
            .collect::<HashSet<_>>();
        roots.insert(config.root_pid);
        let tracked = select_tracked_pids(&rows, &roots);
        let tracked_process_count = tracked.len();
        let process_details = if TWO_STAGE_PROCESS_REFRESH && !tracked.is_empty() {
            let monitor_pid = Pid::from_u32(std::process::id());
            let mut detail_pids = tracked
                .iter()
                .copied()
                .map(Pid::from_u32)
                .collect::<Vec<_>>();
            if !tracked.contains(&monitor_pid.as_u32()) {
                detail_pids.push(monitor_pid);
            }
            // Detail fields need no baseline. Drop command data and OS handles after each sample.
            let mut details = System::new();
            details.refresh_processes_specifics(
                ProcessesToUpdate::Some(&detail_pids),
                true,
                process_refresh_kind().without_cpu(),
            );
            // This process cannot be replaced during collection. Its start time
            // exposes any boot-epoch shift between the two System instances.
            let start_time_offset = self.system.process(monitor_pid).and_then(|process| {
                details.process(monitor_pid).map(|detail| {
                    i128::from(detail.start_time()) - i128::from(process.start_time())
                })
            });
            Some((details, start_time_offset))
        } else {
            None
        };
        let sample_details = process_details
            .as_ref()
            .map_or(&self.system, |(details, _)| details);
        let start_time_offset = process_details
            .as_ref()
            .map_or(Some(0), |(_, offset)| *offset);
        let mut processes = tracked
            .into_iter()
            .filter_map(|pid| {
                let process = self.system.process(Pid::from_u32(pid))?;
                let details = sample_details.process(Pid::from_u32(pid))?;
                if !matches_process_start_time(
                    process.start_time(),
                    details.start_time(),
                    start_time_offset?,
                ) {
                    return None;
                }
                let disk_usage = details.disk_usage();
                let command = if details.cmd().is_empty() {
                    process.name().to_string_lossy().into_owned()
                } else {
                    details
                        .cmd()
                        .iter()
                        .map(|part| part.to_string_lossy())
                        .collect::<Vec<_>>()
                        .join(" ")
                };

                Some(ProcessSample {
                    pid,
                    ppid: process.parent().map(Pid::as_u32).unwrap_or(0),
                    start_time_ms: process.start_time().saturating_mul(1_000),
                    run_time_ms: process.run_time().saturating_mul(1_000),
                    name: truncate_utf8(
                        process.name().to_string_lossy().into_owned(),
                        MAX_PROCESS_NAME_BYTES,
                    ),
                    command: truncate_utf8(command, MAX_PROCESS_COMMAND_BYTES),
                    status: truncate_utf8(
                        format!("{:?}", process.status()),
                        MAX_PROCESS_STATUS_BYTES,
                    ),
                    cpu_percent: process.cpu_usage(),
                    cpu_time_ms: process.accumulated_cpu_time(),
                    resident_bytes: details.memory(),
                    virtual_bytes: details.virtual_memory(),
                    io_read_bytes: disk_usage.total_read_bytes,
                    io_write_bytes: disk_usage.total_written_bytes,
                    io_semantics: io_semantics(),
                })
            })
            .collect::<Vec<_>>();
        drop(process_details);
        processes.sort_by_key(|process| process.pid);
        self.sequence = self.sequence.saturating_add(1);

        SnapshotEvent {
            version: PROTOCOL_VERSION,
            event_type: "snapshot",
            sequence: self.sequence,
            sampled_at_unix_ms: unix_time_ms(),
            collection_duration_micros: collection_started.elapsed().as_micros() as u64,
            scanned_process_count: self.system.processes().len(),
            retained_process_count: processes.len(),
            inaccessible_process_count: inaccessible_process_count(
                tracked_process_count,
                processes.len(),
            ),
            request_id,
            external_processes,
            processes,
        }
    }
}

// Keep CPU baselines separate. Even a metadata refresh resets Linux process times.
fn process_discovery_refresh_kind() -> ProcessRefreshKind {
    if TWO_STAGE_PROCESS_REFRESH {
        ProcessRefreshKind::nothing().with_cpu().without_tasks()
    } else {
        process_refresh_kind()
    }
}

fn process_refresh_kind() -> ProcessRefreshKind {
    ProcessRefreshKind::nothing()
        .with_memory()
        .with_cpu()
        .with_disk_usage()
        .with_cmd(UpdateKind::Always)
        .without_tasks()
}

fn inaccessible_process_count(selected: usize, materialized: usize) -> usize {
    selected.saturating_sub(materialized)
}

fn matches_process_start_time(discovered: u64, detail: u64, epoch_offset: i128) -> bool {
    i128::from(detail) - epoch_offset == i128::from(discovered)
}

fn remaining_cpu_measurement_delay(
    baseline_refreshed_at: Option<Instant>,
    now: Instant,
) -> Option<Duration> {
    baseline_refreshed_at
        .and_then(|baseline| MINIMUM_CPU_UPDATE_INTERVAL.checked_sub(now.duration_since(baseline)))
        .filter(|delay| !delay.is_zero())
}

fn matches_external_identity(
    actual_start_time_ms: u64,
    expected_start_time_ms: Option<u64>,
) -> bool {
    // Match sysinfo's whole-second precision without admitting reused PIDs from adjacent seconds.
    expected_start_time_ms.is_none_or(|expected| {
        actual_start_time_ms == expected - (expected % PROCESS_START_TIME_PRECISION_MS)
    })
}

fn select_tracked_pids(rows: &[(u32, u32, u64)], roots: &HashSet<u32>) -> HashSet<u32> {
    let mut children_by_parent = HashMap::<u32, Vec<(u32, u64)>>::new();
    let mut start_time_by_pid = HashMap::<u32, u64>::new();
    for (pid, ppid, start_time_ms) in rows {
        children_by_parent
            .entry(*ppid)
            .or_default()
            .push((*pid, *start_time_ms));
        start_time_by_pid.insert(*pid, *start_time_ms);
    }

    let mut tracked = HashSet::new();
    let mut visited_identities = HashSet::new();
    let mut queue = roots
        .iter()
        .filter_map(|pid| {
            start_time_by_pid
                .get(pid)
                .map(|start_time_ms| (*pid, *start_time_ms))
        })
        .collect::<VecDeque<_>>();

    while let Some((pid, start_time_ms)) = queue.pop_front() {
        if !visited_identities.insert((pid, start_time_ms)) {
            continue;
        }
        tracked.insert(pid);
        if let Some(children) = children_by_parent.get(&pid) {
            queue.extend(
                children
                    .iter()
                    .copied()
                    .filter(|(_, child_start_time_ms)| *child_start_time_ms >= start_time_ms),
            );
        }
    }

    tracked
}

fn truncate_utf8(mut value: String, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value;
    }
    let mut boundary = max_bytes;
    while !value.is_char_boundary(boundary) {
        boundary = boundary.saturating_sub(1);
    }
    value.truncate(boundary);
    value
}

fn io_semantics() -> IoSemantics {
    if cfg!(target_os = "windows") {
        IoSemantics::AllIo
    } else {
        IoSemantics::Storage
    }
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn clamp_sample_interval(sample_interval_ms: u64) -> Option<Duration> {
    (sample_interval_ms > 0).then(|| {
        Duration::from_millis(
            sample_interval_ms.clamp(MIN_SAMPLE_INTERVAL_MS, MAX_SAMPLE_INTERVAL_MS),
        )
    })
}

fn spawn_input_reader() -> Receiver<Input> {
    let (sender, receiver) = mpsc::sync_channel(INPUT_QUEUE_CAPACITY);
    thread::spawn(move || {
        let stdin = io::stdin();
        for line in stdin.lock().lines() {
            let line = match line {
                Ok(line) => line,
                Err(error) => {
                    let _ = sender.send(Input::Invalid(format!(
                        "failed reading command stream: {error}"
                    )));
                    return;
                }
            };
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<Command>(&line) {
                Ok(command) => {
                    if sender.send(Input::Command(command)).is_err() {
                        return;
                    }
                }
                Err(error) => {
                    if sender
                        .send(Input::Invalid(format!("invalid command: {error}")))
                        .is_err()
                    {
                        return;
                    }
                }
            }
        }
    });
    receiver
}

fn sample_now_deadline(
    current: Option<Instant>,
    interval: Option<Duration>,
    now: Instant,
) -> Option<Instant> {
    current.or_else(|| interval.map(|duration| now + duration))
}

fn write_event<T: Serialize>(writer: &mut impl Write, event: &T) -> io::Result<()> {
    serde_json::to_writer(&mut *writer, event)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

fn write_error(
    writer: &mut impl Write,
    code: &'static str,
    message: impl Into<String>,
    recoverable: bool,
) -> io::Result<()> {
    write_event(
        writer,
        &ErrorEvent {
            version: PROTOCOL_VERSION,
            event_type: "error",
            code,
            message: message.into(),
            recoverable,
        },
    )
}

fn write_history(
    writer: &mut impl Write,
    request_id: &str,
    snapshots: &[SnapshotEvent],
) -> io::Result<()> {
    if snapshots.is_empty() {
        return write_event(
            writer,
            &HistoryChunkEvent {
                version: PROTOCOL_VERSION,
                event_type: "historyChunk",
                request_id,
                done: true,
                snapshots,
            },
        );
    }

    let chunk_count = snapshots.len().div_ceil(HISTORY_CHUNK_SNAPSHOTS);
    for (index, chunk) in snapshots.chunks(HISTORY_CHUNK_SNAPSHOTS).enumerate() {
        write_event(
            writer,
            &HistoryChunkEvent {
                version: PROTOCOL_VERSION,
                event_type: "historyChunk",
                request_id,
                done: index + 1 == chunk_count,
                snapshots: chunk,
            },
        )?;
    }
    Ok(())
}

// This one-shot protocol is separate from the streaming telemetry protocol.
#[cfg(target_os = "macos")]
mod lsof_capture {
    use super::*;
    use std::io::Read;
    use std::process::{Command, Stdio};

    const MAX_BYTES: usize = 16 * 1024 * 1024;
    const MAX_PIDS: usize = 100_000;
    const TIMEOUT: Duration = Duration::from_secs(7);
    const PROC_UID_ONLY: u32 = 4;
    const PROC_PIDT_BSDINFOWITHUNIQID: i32 = 18;

    // XNU sys/proc_info_private.h declares these fixed-size API structures.
    #[repr(C)]
    #[derive(Default)]
    struct UniqueInfo {
        uuid: [u8; 16],
        unique_id: u64,
        parent_unique_id: u64,
        id_version: i32,
        parent_id_version: i32,
        reserved: [u64; 2],
    }
    #[repr(C)]
    struct BsdUniqueInfo {
        bsd: libc::proc_bsdinfo,
        unique: UniqueInfo,
    }
    #[derive(Debug, Clone, PartialEq, Eq)]
    struct Identity {
        uid: u32,
        real_uid: u32,
        saved_uid: u32,
        unique_id: u64,
        id_version: i32,
        uuid: [u8; 16],
    }
    fn unavailable() -> io::Error {
        io::Error::other("Incomplete native process file inventory")
    }
    fn identity(pid: i32) -> io::Result<Identity> {
        // SAFETY: the C ABI buffer is fully initialized and has the SDK layout.
        let mut info: BsdUniqueInfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of_val(&info) as i32;
        let count = unsafe {
            libc::proc_pidinfo(
                pid,
                PROC_PIDT_BSDINFOWITHUNIQID,
                0,
                (&mut info as *mut BsdUniqueInfo).cast(),
                size,
            )
        };
        if count != size || info.bsd.pbi_pid != pid as u32 || info.unique.unique_id == 0 {
            return Err(unavailable());
        }
        Ok(Identity {
            uid: info.bsd.pbi_uid,
            real_uid: info.bsd.pbi_ruid,
            saved_uid: info.bsd.pbi_svuid,
            unique_id: info.unique.unique_id,
            id_version: info.unique.id_version,
            uuid: info.unique.uuid,
        })
    }
    fn census(uid: u32, deadline: Instant) -> io::Result<HashMap<i32, Identity>> {
        let mut pids = vec![0i32; MAX_PIDS];
        let bytes = std::mem::size_of_val(pids.as_slice()) as i32;
        let count =
            unsafe { libc::proc_listpids(PROC_UID_ONLY, uid, pids.as_mut_ptr().cast(), bytes) };
        if count <= 0 || count >= bytes || count % 4 != 0 {
            return Err(unavailable());
        }
        let mut identities = HashMap::new();
        for pid in pids
            .into_iter()
            .take(count as usize / 4)
            .filter(|pid| *pid > 0)
        {
            if Instant::now() >= deadline {
                return Err(unavailable());
            }
            // A failed identity query never grants an exemption; lsof must still
            // supply complete evidence for that process or the capture fails closed.
            if let Ok(value) = identity(pid)
                && value.uid == uid
            {
                identities.insert(pid, value);
            }
        }
        Ok(identities)
    }
    fn empty_result(bytes: i32, errno: i32) -> bool {
        bytes == 0 && errno == 0
    }
    fn empty_fds(pid: i32) -> bool {
        let mut fd = libc::proc_fdinfo {
            proc_fd: 0,
            proc_fdtype: 0,
        };
        // A positive result (including a full/truncated buffer) is never proof.
        // One slot suffices to distinguish zero open descriptors from any open FD.
        unsafe {
            *libc::__error() = 0;
            let count = libc::proc_pidinfo(
                pid,
                libc::PROC_PIDLISTFDS,
                0,
                (&mut fd as *mut libc::proc_fdinfo).cast(),
                std::mem::size_of_val(&fd) as i32,
            );
            let errno = *libc::__error();
            empty_result(count, errno)
        }
    }
    fn matching_empty(
        uid: u32,
        before: &Identity,
        current: &Identity,
        empty: bool,
        after: &Identity,
    ) -> bool {
        before.uid == uid && before == current && before == after && empty
    }
    fn error_pids(output: &str) -> io::Result<Vec<i32>> {
        if !output.ends_with("\0\n") {
            return Err(unavailable());
        }
        let mut pid = None;
        let mut seen = HashSet::new();
        let mut errors = Vec::new();
        let mut numeric = HashSet::new();
        let mut fields: Vec<&str> = Vec::new();
        let finish = |pid: Option<i32>, fields: &[&str], errors: &mut Vec<i32>| -> io::Result<()> {
            if fields.first() == Some(&"ferr") {
                if fields != ["ferr", "nFD info error: Invalid argument"] {
                    return Err(unavailable());
                }
                let pid = pid.ok_or_else(unavailable)?;
                if errors.contains(&pid) {
                    return Err(unavailable());
                }
                errors.push(pid);
            }
            Ok(())
        };
        for raw in output.split('\0') {
            let field = raw.strip_prefix('\n').unwrap_or(raw);
            if field.is_empty() {
                continue;
            }
            if let Some(value) = field.strip_prefix('p') {
                finish(pid, &fields, &mut errors)?;
                fields.clear();
                let value = value.parse::<i32>().map_err(|_| unavailable())?;
                if value <= 0 || !seen.insert(value) || seen.len() > MAX_PIDS {
                    return Err(unavailable());
                }
                pid = Some(value);
            } else if let Some(value) = field.strip_prefix('f') {
                finish(pid, &fields, &mut errors)?;
                fields.clear();
                if !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()) {
                    numeric.insert(pid.ok_or_else(unavailable)?);
                }
                fields.push(field);
            } else {
                fields.push(field);
            }
        }
        finish(pid, &fields, &mut errors)?;
        if errors.iter().any(|pid| numeric.contains(pid)) {
            return Err(unavailable());
        }
        Ok(errors)
    }
    fn bounded_read(reader: impl Read, limit: usize) -> io::Result<Vec<u8>> {
        let mut output = Vec::new();
        reader.take(limit as u64 + 1).read_to_end(&mut output)?;
        if output.len() > limit {
            return Err(unavailable());
        }
        Ok(output)
    }
    fn lsof(uid: u32, deadline: Instant) -> io::Result<String> {
        if Instant::now() >= deadline {
            return Err(unavailable());
        }
        let mut child = Command::new("/usr/sbin/lsof")
            .args(["-a", "-u", &uid.to_string(), "-F0pftnDi", "-n", "-P"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let stdout = child.stdout.take().ok_or_else(unavailable)?;
        let stderr = child.stderr.take().ok_or_else(unavailable)?;
        let out = thread::spawn(move || bounded_read(stdout, MAX_BYTES));
        let err = thread::spawn(move || bounded_read(stderr, 64 * 1024));
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Ok(status),
                Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
                result => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break Err(result.err().unwrap_or_else(unavailable));
                }
            }
        };
        let stdout = out.join().map_err(|_| unavailable())??;
        let stderr = err.join().map_err(|_| unavailable())??;
        if !status?.success() || !stderr.is_empty() {
            return Err(unavailable());
        }
        String::from_utf8(stdout).map_err(|_| unavailable())
    }
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Header {
        version: u32,
        #[serde(rename = "type")]
        kind: &'static str,
        uid: u32,
        empty_fd_pids: Vec<i32>,
    }
    pub(super) fn run(uid: u32) -> io::Result<()> {
        // Share one budget so the server's outer timeout cannot strand lsof
        // after an unusually expensive census.
        let deadline = Instant::now() + TIMEOUT;
        let before = census(uid, deadline)?;
        let output = lsof(uid, deadline)?;
        let pids = error_pids(&output)?;
        for pid in &pids {
            if Instant::now() >= deadline {
                return Err(unavailable());
            }
            let before = before.get(pid).ok_or_else(unavailable)?;
            let current = identity(*pid)?;
            let empty = empty_fds(*pid);
            let after = identity(*pid)?;
            if !matching_empty(uid, before, &current, empty, &after) {
                return Err(unavailable());
            }
        }
        let mut writer = BufWriter::new(io::stdout().lock());
        serde_json::to_writer(
            &mut writer,
            &Header {
                version: 1,
                kind: "lsofCapture",
                uid,
                empty_fd_pids: pids,
            },
        )?;
        writer.write_all(b"\n")?;
        writer.write_all(output.as_bytes())?;
        writer.flush()
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn refuses_error_nonempty_and_truncated_results() {
            assert!(empty_result(0, 0));
            for (bytes, errno) in [(0, libc::EINVAL), (-1, 0), (8, 0), (16, 0)] {
                assert!(!empty_result(bytes, errno));
            }
        }
        #[test]
        fn exact_error_record_only_without_numeric_fds() {
            let fixture = "p123\0\nfcwd\0tDIR\0n/workspace/elsewhere\0\nferr\0nFD info error: Invalid argument\0\n";
            assert_eq!(error_pids(fixture).unwrap(), [123]);
            for output in [
                fixture.replace("Invalid argument", "Permission denied"),
                format!("{fixture}f4\0tREG\0n/example\0\n"),
                fixture.replace("ferr\0", "ferr\0tREG\0"),
                fixture.trim_end_matches('\n').to_string(),
            ] {
                assert!(error_pids(&output).is_err());
            }
        }
        #[test]
        fn identity_uid_and_generation_must_match() {
            let id = Identity {
                uid: 501,
                real_uid: 501,
                saved_uid: 501,
                unique_id: 42,
                id_version: 7,
                uuid: [0; 16],
            };
            assert!(matching_empty(501, &id, &id, true, &id));
            assert!(!matching_empty(501, &id, &id, false, &id));
            assert!(!matching_empty(502, &id, &id, true, &id));
            for changed in [
                Identity {
                    uid: 502,
                    ..id.clone()
                },
                Identity {
                    unique_id: 43,
                    ..id.clone()
                },
                Identity {
                    id_version: 8,
                    ..id.clone()
                },
                Identity {
                    uuid: [1; 16],
                    ..id.clone()
                },
            ] {
                assert!(!matching_empty(501, &id, &changed, true, &id));
                assert!(!matching_empty(501, &id, &id, true, &changed));
            }
        }
        #[test]
        fn kernel_empty_fixture() {
            if std::env::var_os("T3_TEST_EMPTY_FDS").is_none() {
                return;
            }
            // This runs only in the test-owned child. Close stdout last so its
            // EOF is the parent's deterministic readiness signal.
            let mut fds = vec![
                libc::proc_fdinfo {
                    proc_fd: 0,
                    proc_fdtype: 0
                };
                4096
            ];
            let count = unsafe {
                libc::proc_pidinfo(
                    std::process::id() as i32,
                    libc::PROC_PIDLISTFDS,
                    0,
                    fds.as_mut_ptr().cast(),
                    std::mem::size_of_val(fds.as_slice()) as i32,
                )
            };
            assert!(count > 0 && count < std::mem::size_of_val(fds.as_slice()) as i32);
            for fd in fds
                .iter()
                .take(count as usize / std::mem::size_of::<libc::proc_fdinfo>())
            {
                if fd.proc_fd != 1 {
                    unsafe {
                        libc::close(fd.proc_fd);
                    }
                }
            }
            unsafe {
                libc::close(1);
            }
            loop {
                unsafe {
                    libc::pause();
                }
            }
        }
        #[test]
        fn real_kernel_empty_table_clears_stale_errno() {
            struct Child(std::process::Child);
            impl Drop for Child {
                fn drop(&mut self) {
                    let _ = self.0.kill();
                    let _ = self.0.wait();
                }
            }
            let mut child = Child(
                Command::new(std::env::current_exe().unwrap())
                    .args([
                        "--exact",
                        "lsof_capture::tests::kernel_empty_fixture",
                        "--nocapture",
                    ])
                    .env("T3_TEST_EMPTY_FDS", "1")
                    .stdin(Stdio::null())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null())
                    .spawn()
                    .unwrap(),
            );
            bounded_read(child.0.stdout.take().unwrap(), 64 * 1024).unwrap();
            let pid = child.0.id() as i32;
            let before = identity(pid).unwrap();
            unsafe {
                *libc::__error() = libc::EINVAL;
            }
            assert!(empty_fds(pid));
            let after = identity(pid).unwrap();
            assert!(matching_empty(before.uid, &before, &before, true, &after));
            // The actual OS lsof seam emits ferr for this successful empty table.
            let capture = Command::new("/usr/sbin/lsof")
                .args(["-a", "-p", &pid.to_string(), "-F0pftnDi", "-n", "-P"])
                .output()
                .unwrap();
            assert!(capture.status.success());
            assert!(capture.stderr.is_empty());
            let output = String::from_utf8(capture.stdout).unwrap();
            let errors = error_pids(&output).unwrap();
            // Some lsof versions correctly omit the erroneous record.
            assert!(errors.is_empty() || errors == [pid]);
            assert!(matching_empty(
                before.uid,
                &before,
                &identity(pid).unwrap(),
                empty_fds(pid),
                &identity(pid).unwrap()
            ));
        }
        #[test]
        fn bounded_capture_rejects_overflow() {
            assert!(bounded_read(&b"12345"[..], 4).is_err());
            assert_eq!(bounded_read(&b"1234"[..], 4).unwrap(), b"1234");
        }
        #[test]
        fn real_kernel_nonempty_process_is_not_empty_and_has_stable_identity() {
            let pid = std::process::id() as i32;
            let before = identity(pid).unwrap();
            assert!(!empty_fds(pid));
            assert_eq!(before, identity(pid).unwrap());
            assert_eq!(before.uid, unsafe { libc::geteuid() });
            assert!(
                census(before.uid, Instant::now() + TIMEOUT)
                    .unwrap()
                    .contains_key(&pid)
            );
            assert!(identity(i32::MAX).is_err());
            assert!(!empty_fds(i32::MAX));
        }
    }
}

fn main() -> io::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if !args.is_empty() {
        #[cfg(target_os = "macos")]
        if args.len() == 2 && args[0] == "capture-lsof-v1" {
            let uid = args[1]
                .parse::<u32>()
                .map_err(|_| io::Error::other("Invalid UID"))?;
            return lsof_capture::run(uid);
        }
        return Err(io::Error::other("Unsupported resource monitor command"));
    }
    let mut writer = BufWriter::new(io::stdout().lock());
    write_event(
        &mut writer,
        &HelloEvent {
            version: PROTOCOL_VERSION,
            event_type: "hello",
            sidecar_version: env!("CARGO_PKG_VERSION"),
            sidecar_pid: std::process::id(),
            platform: std::env::consts::OS,
            arch: std::env::consts::ARCH,
            capabilities: Capabilities {
                cumulative_cpu_time: true,
                current_cpu_percent: true,
                resident_memory: true,
                virtual_memory: true,
                io_bytes: true,
                process_start_time: true,
                process_tree: true,
            },
        },
    )?;

    let receiver = spawn_input_reader();
    let mut collector = Collector::new();
    let mut history = HistoryRecorder::default();
    let mut config: Option<CollectorConfig> = None;
    let mut next_sample_at: Option<Instant> = None;
    let mut streaming_enabled = false;

    loop {
        if next_sample_at.is_some_and(|deadline| deadline <= Instant::now()) {
            if let Some(current) = config.as_ref() {
                if let Some(interval) = current.sample_interval {
                    let event = collector.sample(current, None);
                    history.record(&event);
                    if streaming_enabled {
                        write_event(&mut writer, &event)?;
                    }
                    next_sample_at = Some(Instant::now() + interval);
                } else {
                    next_sample_at = None;
                }
            } else {
                next_sample_at = None;
            }
            continue;
        }

        let timeout = next_sample_at
            .map(|deadline| deadline.saturating_duration_since(Instant::now()))
            .unwrap_or(Duration::from_secs(60));

        match receiver.recv_timeout(timeout) {
            Ok(Input::Invalid(message)) => {
                write_error(&mut writer, "invalid-command", message, true)?;
            }
            Ok(Input::Command(command)) => {
                if command.version() != PROTOCOL_VERSION {
                    write_error(
                        &mut writer,
                        "protocol-mismatch",
                        format!(
                            "unsupported protocol version {}; expected {PROTOCOL_VERSION}",
                            command.version()
                        ),
                        false,
                    )?;
                    continue;
                }

                match command {
                    Command::Configure {
                        root_pid,
                        sample_interval_ms,
                        external_processes,
                        ..
                    } => {
                        let sample_interval = clamp_sample_interval(sample_interval_ms);
                        config = Some(CollectorConfig {
                            root_pid,
                            sample_interval,
                            external_processes: external_processes
                                .into_iter()
                                .map(|process| (process.pid, process.start_time_ms))
                                .collect(),
                        });
                        collector.prime_cpu_usage();
                        next_sample_at = sample_interval.map(|_| Instant::now());
                    }
                    Command::SetExternalProcesses { processes, .. } => {
                        if let Some(current) = config.as_mut() {
                            current.external_processes = processes
                                .into_iter()
                                .map(|process| (process.pid, process.start_time_ms))
                                .collect();
                        } else {
                            write_error(
                                &mut writer,
                                "not-configured",
                                "configure must be sent before external processes",
                                true,
                            )?;
                        }
                    }
                    Command::SetSampleInterval {
                        sample_interval_ms, ..
                    } => {
                        if let Some(current) = config.as_mut() {
                            current.sample_interval = clamp_sample_interval(sample_interval_ms);
                            next_sample_at = current
                                .sample_interval
                                .map(|interval| Instant::now() + interval);
                        } else {
                            write_error(
                                &mut writer,
                                "not-configured",
                                "configure must be sent before changing the sample interval",
                                true,
                            )?;
                        }
                    }
                    Command::SetStreaming { enabled, .. } => {
                        streaming_enabled = enabled;
                    }
                    Command::SampleNow { request_id, .. } => {
                        if let Some(current) = config.as_ref() {
                            let event = collector.sample(current, Some(request_id));
                            history.record(&event);
                            write_event(&mut writer, &event)?;
                            next_sample_at = sample_now_deadline(
                                next_sample_at,
                                current.sample_interval,
                                Instant::now(),
                            );
                        } else {
                            write_error(
                                &mut writer,
                                "not-configured",
                                "configure must be sent before sampling",
                                true,
                            )?;
                        }
                    }
                    Command::ProcessTable { request_id, .. } => {
                        let event = ProcessTableEvent {
                            version: PROTOCOL_VERSION,
                            event_type: "processTable",
                            request_id: &request_id,
                            processes: collector.process_table(),
                        };
                        write_event(&mut writer, &event)?;
                    }
                    Command::ReadHistory {
                        request_id,
                        window_ms,
                        ..
                    } => {
                        if config.is_some() {
                            let snapshots = history.read(window_ms, unix_time_ms());
                            write_history(&mut writer, &request_id, &snapshots)?;
                        } else {
                            write_error(
                                &mut writer,
                                "not-configured",
                                "configure must be sent before reading history",
                                true,
                            )?;
                        }
                    }
                    Command::Shutdown { .. } => return Ok(()),
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_roots_and_all_descendants() {
        let rows = vec![
            (10, 1, 1_000),
            (11, 10, 1_100),
            (12, 11, 1_200),
            (20, 1, 2_000),
            (21, 20, 2_100),
            (30, 99, 3_000),
        ];
        let tracked = select_tracked_pids(&rows, &HashSet::from([10, 20]));

        assert_eq!(tracked, HashSet::from([10, 11, 12, 20, 21]));
    }

    #[test]
    fn rejects_descendants_older_than_a_reused_parent_pid() {
        let rows = vec![
            (20, 1, 5_000),
            (21, 20, 4_000),
            (22, 20, 5_100),
            (23, 21, 5_200),
        ];
        let tracked = select_tracked_pids(&rows, &HashSet::from([20]));

        assert_eq!(tracked, HashSet::from([20, 22]));
    }

    #[test]
    fn ignores_missing_roots() {
        let rows = vec![(10, 1, 1_000), (11, 10, 1_100)];
        let tracked = select_tracked_pids(&rows, &HashSet::from([99]));

        assert!(tracked.is_empty());
    }

    #[test]
    fn validates_external_process_start_identity() {
        assert!(matches_external_identity(10_000, None));
        assert!(matches_external_identity(10_000, Some(10_999)));
        assert!(!matches_external_identity(10_000, Some(11_000)));
        assert!(!matches_external_identity(10_000, Some(9_999)));
    }

    #[test]
    fn loads_details_when_an_existing_process_becomes_selected() {
        let mut collector = Collector::new();
        let mut config = CollectorConfig {
            root_pid: u32::MAX,
            sample_interval: None,
            external_processes: HashMap::new(),
        };
        assert!(collector.sample(&config, None).processes.is_empty());

        config.root_pid = std::process::id();
        let snapshot = collector.sample(&config, None);
        let process = snapshot
            .processes
            .iter()
            .find(|process| process.pid == config.root_pid)
            .expect("selected process");

        assert!(!process.command.is_empty());
        assert!(process.resident_bytes > 0);
        assert!(process.cpu_percent.is_finite());
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn keeps_command_lines_and_memory_out_of_the_discovery_table() {
        let mut collector = Collector::new();
        let mut config = CollectorConfig {
            root_pid: u32::MAX,
            sample_interval: None,
            external_processes: HashMap::new(),
        };
        assert!(collector.sample(&config, None).processes.is_empty());

        let pid = Pid::from_u32(std::process::id());
        let unselected = collector.system.process(pid).expect("discovered process");
        assert!(unselected.cmd().is_empty());
        assert_eq!(unselected.memory(), 0);
        assert_eq!(unselected.virtual_memory(), 0);

        config.external_processes.insert(pid.as_u32(), None);
        let snapshot = collector.sample(&config, None);
        let selected = snapshot
            .processes
            .iter()
            .find(|process| process.pid == pid.as_u32())
            .expect("external process details");
        assert!(!selected.command.is_empty());
        assert!(selected.resident_bytes > 0);
        assert!(selected.start_time_ms > 0);

        let retained = collector
            .system
            .process(pid)
            .expect("retained CPU baseline");
        assert!(retained.cmd().is_empty());
        assert_eq!(retained.memory(), 0);
        assert_eq!(retained.virtual_memory(), 0);
    }

    #[test]
    fn accepts_clock_shifts_without_accepting_reused_process_starts() {
        assert!(matches_process_start_time(10_000, 13_600, 3_600));
        assert!(!matches_process_start_time(10_000, 13_601, 3_600));
        assert!(matches_process_start_time(10_000, 6_400, -3_600));
        assert!(!matches_process_start_time(10_000, 6_401, -3_600));
        assert!(matches_process_start_time(10_000, 10_000, 0));
        assert!(!matches_process_start_time(10_000, 10_001, 0));
    }

    #[test]
    fn decodes_protocol_commands() {
        let configure = serde_json::from_str::<Command>(
            r#"{"version":3,"type":"configure","rootPid":42,"sampleIntervalMs":1000,"externalProcesses":[{"pid":7}]}"#,
        )
        .expect("configure command");

        match configure {
            Command::Configure {
                root_pid,
                sample_interval_ms,
                external_processes,
                ..
            } => {
                assert_eq!(root_pid, 42);
                assert_eq!(sample_interval_ms, 1_000);
                assert_eq!(external_processes[0].pid, 7);
                assert_eq!(external_processes[0].start_time_ms, None);
            }
            _ => panic!("unexpected command"),
        }

        let read_history = serde_json::from_str::<Command>(
            r#"{"version":3,"type":"readHistory","requestId":"history-1","windowMs":60000}"#,
        )
        .expect("read history command");
        assert!(matches!(
            read_history,
            Command::ReadHistory {
                request_id,
                window_ms: 60_000,
                ..
            } if request_id == "history-1"
        ));

        let process_table = serde_json::from_str::<Command>(
            r#"{"version":3,"type":"processTable","requestId":"processes-1"}"#,
        )
        .expect("process table command");
        assert!(matches!(
            process_table,
            Command::ProcessTable { request_id, .. } if request_id == "processes-1"
        ));
    }

    #[test]
    fn clamps_sample_interval() {
        assert_eq!(clamp_sample_interval(0), None);
        assert_eq!(clamp_sample_interval(1), Some(Duration::from_millis(250)));
        assert_eq!(
            clamp_sample_interval(100_000),
            Some(Duration::from_millis(60_000))
        );
    }

    #[test]
    fn counts_selected_processes_that_could_not_be_materialized() {
        assert_eq!(inaccessible_process_count(5, 3), 2);
        assert_eq!(inaccessible_process_count(3, 5), 0);
    }

    #[test]
    fn waits_for_a_cpu_measurement_window_after_priming() {
        let baseline = Instant::now();

        assert_eq!(
            remaining_cpu_measurement_delay(Some(baseline), baseline),
            Some(MINIMUM_CPU_UPDATE_INTERVAL)
        );
        assert_eq!(
            remaining_cpu_measurement_delay(Some(baseline), baseline + MINIMUM_CPU_UPDATE_INTERVAL),
            None
        );
        assert_eq!(remaining_cpu_measurement_delay(None, baseline), None);
    }

    #[test]
    fn retains_bounded_history_without_request_ids() {
        let mut history = HistoryRecorder::default();
        for sequence in 0..=MAX_HISTORY_SNAPSHOTS {
            history.record(&SnapshotEvent {
                version: PROTOCOL_VERSION,
                event_type: "snapshot",
                sequence: sequence as u64,
                sampled_at_unix_ms: sequence as u64 * 1_000,
                collection_duration_micros: 1,
                scanned_process_count: 0,
                retained_process_count: 0,
                inaccessible_process_count: 0,
                request_id: Some("request".to_owned()),
                external_processes: vec![ExternalProcess {
                    pid: 7,
                    start_time_ms: Some(1_000),
                }],
                processes: Vec::new(),
            });
        }

        assert_eq!(history.snapshots.len(), MAX_HISTORY_SNAPSHOTS);
        assert!(
            history
                .snapshots
                .iter()
                .all(|snapshot| snapshot.request_id.is_none())
        );
        assert!(history.snapshots.iter().all(|snapshot| {
            snapshot.external_processes.len() == 1
                && snapshot.external_processes[0].pid == 7
                && snapshot.external_processes[0].start_time_ms == Some(1_000)
        }));
        assert_eq!(
            history
                .read(10_000, MAX_HISTORY_SNAPSHOTS as u64 * 1_000)
                .len(),
            11
        );
    }

    #[test]
    fn excludes_and_trims_future_history_after_the_clock_moves_backward() {
        let mut history = HistoryRecorder::default();
        let snapshot = SnapshotEvent {
            version: PROTOCOL_VERSION,
            event_type: "snapshot",
            sequence: 1,
            sampled_at_unix_ms: 2_000,
            collection_duration_micros: 1,
            scanned_process_count: 0,
            retained_process_count: 0,
            inaccessible_process_count: 0,
            request_id: None,
            external_processes: Vec::new(),
            processes: Vec::new(),
        };
        history.record(&snapshot);

        assert!(history.read(0, 1_000).is_empty());

        history.record(&SnapshotEvent {
            sequence: 2,
            sampled_at_unix_ms: 1_000,
            ..snapshot
        });
        assert_eq!(history.snapshots.len(), 1);
        assert_eq!(
            history.snapshots.front().map(|entry| entry.sequence),
            Some(2)
        );
    }

    #[test]
    fn bounds_history_by_estimated_process_bytes() {
        let mut history = HistoryRecorder::default();
        let command = "x".repeat(128);
        let process = ProcessSample {
            pid: 1,
            ppid: 0,
            start_time_ms: 0,
            run_time_ms: 0,
            name: "process".to_owned(),
            command,
            status: "Run".to_owned(),
            cpu_percent: 0.0,
            cpu_time_ms: 0,
            resident_bytes: 0,
            virtual_bytes: 0,
            io_read_bytes: 0,
            io_write_bytes: 0,
            io_semantics: IoSemantics::Storage,
        };
        let snapshot_bytes =
            std::mem::size_of::<SnapshotEvent>() + process.estimated_history_bytes();
        for sequence in 0..3 {
            history.record_with_limits(
                &SnapshotEvent {
                    version: PROTOCOL_VERSION,
                    event_type: "snapshot",
                    sequence,
                    sampled_at_unix_ms: sequence * 1_000,
                    collection_duration_micros: 1,
                    scanned_process_count: 1,
                    retained_process_count: 1,
                    inaccessible_process_count: 0,
                    request_id: None,
                    external_processes: Vec::new(),
                    processes: vec![ProcessSample {
                        pid: sequence as u32 + 1,
                        start_time_ms: sequence * 1_000,
                        ..process.clone()
                    }],
                },
                3,
                3,
                snapshot_bytes * 2,
            );
        }

        assert!(history.retained_bytes <= snapshot_bytes * 2);
        assert_eq!(history.snapshots.len(), 2);
        assert_eq!(
            history.snapshots.front().map(|snapshot| snapshot.sequence),
            Some(1)
        );
    }

    #[test]
    fn counts_external_processes_toward_history_limits() {
        let mut history = HistoryRecorder::default();
        let external_processes = (1..=128)
            .map(|pid| ExternalProcess {
                pid,
                start_time_ms: Some(u64::from(pid) * 1_000),
            })
            .collect::<Vec<_>>();
        let snapshot = SnapshotEvent {
            version: PROTOCOL_VERSION,
            event_type: "snapshot",
            sequence: 0,
            sampled_at_unix_ms: 0,
            collection_duration_micros: 1,
            scanned_process_count: 0,
            retained_process_count: 0,
            inaccessible_process_count: 0,
            request_id: None,
            external_processes,
            processes: Vec::new(),
        };
        let snapshot_bytes = snapshot.estimated_history_bytes();
        let snapshot_entries = snapshot.retained_entry_count();

        for sequence in 0..3 {
            history.record_with_limits(
                &SnapshotEvent {
                    sequence,
                    sampled_at_unix_ms: sequence * 1_000,
                    ..snapshot.clone()
                },
                3,
                snapshot_entries * 2,
                snapshot_bytes * 2,
            );
        }

        assert_eq!(history.retained_entry_count, snapshot_entries * 2);
        assert!(history.retained_bytes <= snapshot_bytes * 2);
        assert_eq!(history.snapshots.len(), 2);
        assert_eq!(
            history.snapshots.front().map(|snapshot| snapshot.sequence),
            Some(1)
        );
    }

    #[test]
    fn truncates_process_strings_at_utf8_boundaries() {
        let value = "é".repeat(MAX_PROCESS_NAME_BYTES);
        let truncated = truncate_utf8(value, MAX_PROCESS_NAME_BYTES - 1);

        assert!(truncated.len() < MAX_PROCESS_NAME_BYTES);
        assert!(truncated.is_char_boundary(truncated.len()));
    }

    #[test]
    fn refreshes_commands_without_enumerating_linux_tasks() {
        let refresh_kind = process_refresh_kind();

        assert_eq!(refresh_kind.cmd(), UpdateKind::Always);
        assert!(!refresh_kind.tasks());
        assert!(refresh_kind.cpu());
        assert!(refresh_kind.memory());
        assert!(refresh_kind.disk_usage());
    }

    #[test]
    fn sample_now_does_not_postpone_an_existing_periodic_deadline() {
        let now = Instant::now();
        let deadline = now + Duration::from_secs(1);

        assert_eq!(
            sample_now_deadline(
                Some(deadline),
                Some(Duration::from_secs(5)),
                now + Duration::from_millis(100)
            ),
            Some(deadline)
        );
    }
}
