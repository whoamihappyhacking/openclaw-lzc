(function () {
  const checkInterval = setInterval(function () {
    fetch("/tower/status")
      .then(function (res) {
        return res.json();
      })
      .then(function (status) {
        const needsTower =
          (status.updateRequired && !status.userConfirmed) ||
          status.awaitingReturn ||
          status.status === "crashed" ||
          status.status === "stopped";

        const needsCrashConfirm =
          status.status === "running" && status.crashCount > 0 && !status.userConfirmed;

        if (needsTower || needsCrashConfirm) {
          clearInterval(checkInterval);
          window.location.reload();
        }
      })
      .catch(function () {
        // Keep polling; transient network errors are expected during restarts.
      });
  }, 2000);
})();
