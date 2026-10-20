const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const helper = "/usr/local/libexec/openclaw-migration-offline";
test("maintenance forbids network sockets in descendants while retaining Unix IPC", { skip: !fs.existsSync(helper) }, () => {
  const script = `import socket, errno, subprocess, sys
for family in [socket.AF_INET, socket.AF_INET6, socket.AF_NETLINK]:
    try:
        socket.socket(family)
        raise AssertionError('network socket was allowed')
    except OSError as e:
        assert e.errno == errno.EPERM
a,b=socket.socketpair()
a.send(b'unix IPC works')
assert b.recv(100) == b'unix IPC works'
assert subprocess.run([sys.executable, '-c', 'import socket; socket.socket(socket.AF_INET)'], check=False, capture_output=True).returncode == 1
print('isolated')`;
  assert.equal(execFileSync(helper, ["python3", "-c", script], { encoding: "utf8" }).trim(), "isolated");
});
