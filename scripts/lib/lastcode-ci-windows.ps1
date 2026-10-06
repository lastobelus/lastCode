# The recorded process owns a noninherited kernel job before starting any check.
# Start-Process -Wait tracks its tree; the outer job also guards fallback waits.
$ErrorActionPreference = 'Stop'
$emptyInput = $null
try {
    $start = [Console]::ReadLine()
    if ([string]::IsNullOrEmpty($start)) { exit 1 }
    $payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($start)) | ConvertFrom-Json
    if ([string]::IsNullOrEmpty($payload.filePath)) { exit 1 }

    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
public static class LastCodeCiJob {
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveLimit;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters {
        public ulong ReadCount, WriteCount, OtherCount, ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct Accounting {
        public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
        public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint length);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, uint length, out uint returned);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    // Keep this raw, noninherited handle until process termination. Closing it
    // while the owner is still running would also terminate the owner itself.
    static IntPtr job;
    static void Check(bool success) {
        if (!success) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    public static void Initialize() {
        job = CreateJobObject(IntPtr.Zero, null);
        Check(job != IntPtr.Zero);
        ExtendedLimits limits = new ExtendedLimits();
        limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; no breakaway.
        Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))));
        Check(AssignProcessToJobObject(job, GetCurrentProcess()));
        Thread guardian = new Thread(() => {
            try { Console.ReadLine(); } catch (IOException) { }
            if (!TerminateJobObject(job, 1)) Environment.Exit(1);
        });
        guardian.IsBackground = true;
        guardian.Start();
    }
    public static void WaitForDescendants() {
        while (true) {
            Accounting info;
            uint returned;
            Check(QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf(typeof(Accounting)), out returned));
            if (info.ActiveProcesses <= 1) return; // The owner is the only remaining process.
            Thread.Sleep(50);
        }
    }
}
'@
    [LastCodeCiJob]::Initialize()
    $emptyInput = New-TemporaryFile
    $launch = @{
        FilePath = [string]$payload.filePath
        WorkingDirectory = [string]$payload.cwd
        RedirectStandardInput = $emptyInput.FullName
        NoNewWindow = $true
        PassThru = $true
        Wait = $true
    }
    if (![string]::IsNullOrEmpty($payload.argumentLine)) {
        $launch.ArgumentList = [string]$payload.argumentLine
    }
    $check = Start-Process @launch
    $check.WaitForExit()
    $exitCode = [int]$check.ExitCode
    [LastCodeCiJob]::WaitForDescendants()
    exit $exitCode
} catch {
    [Console]::Error.WriteLine('Windows CI process tree setup or execution failed.')
    exit 1
} finally {
    if ($null -ne $emptyInput) { Remove-Item -LiteralPath $emptyInput.FullName -Force -ErrorAction SilentlyContinue }
}
