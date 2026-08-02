const status = document.querySelector('#status');

try {
  const daemon = await window.tsukiori.daemon.status();
  const versions = await window.tsukiori.versions();
  status.textContent =
    'Daemon ' + daemon.daemonVersion +
    ' · Protocol ' + versions.protocol +
    ' · ' + daemon.state;
} catch {
  status.textContent = 'Daemon 不可用';
}
