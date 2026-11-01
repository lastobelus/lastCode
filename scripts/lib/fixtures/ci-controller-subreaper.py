"""Keep this fixture's terminated orphans waitable until their state is recorded."""

import ctypes
import json
import os
from pathlib import Path
import signal
import subprocess
import sys

libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
    raise OSError(ctypes.get_errno(), "could not own fixture orphans")


def group_members(group):
    members = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdecimal():
            continue
        try:
            fields = (entry / "stat").read_text().rsplit(")", 1)[1].split()
        except FileNotFoundError:
            continue
        if int(fields[2]) == group:
            members.append({
                "pid": int(entry.name), "parentPid": int(fields[1]),
                "group": int(fields[2]), "state": fields[0],
            })
    return members


def probe_group(group):
    try:
        os.killpg(group, 0)
        return None
    except OSError as error:
        return error.errno


def reap_children():
    try:
        while True:
            os.waitpid(-1, 0)
    except ChildProcessError:
        pass


# execFile's timeout sends TERM; use the same exact-process cleanup on failure.
signal.signal(signal.SIGTERM, lambda *_: sys.exit(1))
controller = subprocess.Popen(
    [sys.argv[1], "controller.mjs"], stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT, text=True,
)
worker_pid = None
descendant_pid = None
before = []
try:
    for line in controller.stdout:
        if line.startswith("worker-pid:"):
            worker_pid = int(line.split(":", 1)[1])
        if line.startswith("descendant-ready:"):
            descendant_pid = int(line.split(":", 1)[1])
            before = group_members(worker_pid)
            controller.kill()
    # EOF marks closure of the inherited output pipe. Reap the controller only;
    # the dead worker and descendant stay owned by this subreaper for inspection.
    controller_exit = controller.wait()
    pipe_close_probe_error = probe_group(worker_pid)
    pipe_close_members = group_members(worker_pid)
    # Confirm both captured processes terminated without reaping them. EOF and
    # the kernel's zombie transition need not be observed in the same instant.
    terminated = []
    for pid in (worker_pid, descendant_pid):
        status = os.waitid(os.P_PID, pid, os.WEXITED | os.WNOWAIT)
        terminated.append({"pid": pid, "code": status.si_code, "status": status.si_status})
    probe_error = probe_group(worker_pid)
    members = group_members(worker_pid)
finally:
    if controller.poll() is None:
        controller.kill()
    if worker_pid is not None:
        try:
            os.killpg(worker_pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    controller.wait()
    reap_children()

print(json.dumps({
    "phase": "after-output-pipe-close-before-orphan-reaping",
    "controllerPid": controller.pid, "controllerExit": controller_exit,
    "subreaperPid": os.getpid(), "workerPid": worker_pid,
    "descendantPid": descendant_pid, "before": before, "members": members,
    "pipeCloseGroupProbeError": pipe_close_probe_error,
    "pipeCloseMembers": pipe_close_members,
    "terminatedWithoutReaping": terminated,
    "groupProbeError": probe_error, "reapedGroupProbeError": probe_group(worker_pid),
}))
