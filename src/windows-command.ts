import { win32 } from "node:path";

// Adapted from cross-spawn's MIT-licensed cmd escaping; see NOTICE.md.
export function windowsCommand(command: string, args: string[]) {
  const meta = /([()\][%!^"\x60<>&|;, *?])/g;
  const doubleEscape = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(command);
  const escaped = args.map(arg => {
    arg = arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"').replace(/(?=(\\+?)?)\1$/, "$1$1");
    arg = ('"' + arg + '"').replace(meta, "^$1");
    return doubleEscape ? arg.replace(meta, "^$1") : arg;
  });
  const shellCommand = [win32.normalize(command).replace(meta, "^$1"), ...escaped].join(" ");
  return {
    command: process.env.ComSpec ?? process.env.comspec ?? "cmd.exe",
    args: ["/d", "/s", "/c", '"' + shellCommand + '"'],
    windowsVerbatimArguments: true,
  };
}
