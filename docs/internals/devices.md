# The server shuts down simulators agents boot

Agents often hand back without powering off, and a forgotten claim keeps a
simulator running for days. The server turns off agent-device's idle timeout,
so [`DeviceService`](../../apps/server/src/device/DeviceService.ts) remembers
each local device an agent's `device_open` booted and shuts it down when its
thread settles, archives or is deleted and no other session holds it, after 30
minutes without device commands, and when the server stops. Devices the user
booted, or that were running when an agent opened them, are never recorded. A
device seen stopped is forgotten, and turning off device support forgets them
all, so a later user boot is safe. The record is in memory: a server that stops
cleanly shuts down what it booted, and one that crashes leaves those simulators
running.
