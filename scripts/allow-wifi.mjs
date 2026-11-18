console.log("Connect Pi uses Tailscale HTTPS for phone access. The old direct HTTP Wi-Fi mode has been removed.");
if (process.argv[2]?.toLowerCase() === "on") process.exitCode = 1;
