export const LASTCODE_DESKTOP_DISTRIBUTION = {
  productName: "LastCode",
  asciiName: "LastCode",
  appId: "codes.lastobelus.lastcode",
  developmentAppId: "codes.lastobelus.lastcode.dev",
  productionScheme: "lastcode",
  developmentScheme: "lastcode-dev",
  executableName: "lastcode",
  developmentExecutableName: "lastcode-dev",
  defaultHomeDirName: ".lastcode",
  userDataDirName: "lastcode",
  developmentUserDataDirName: "lastcode-dev",
  linuxDesktopEntryName: "lastcode.desktop",
  developmentLinuxDesktopEntryName: "lastcode-dev.desktop",
  linuxUrlHandlerDesktopEntryName: "lastcode-url-handler.desktop",
} as const;

export const DESKTOP_CLI_SHIM_MARKER = "Written by T3 Code: runs the desktop app's bundled t3 CLI.";

export const LASTCODE_TRIAGE_CLI_COMMAND = '"${T3CODE_HOME:-$HOME/.lastcode}/bin/t3" triage';
export const LASTCODE_TRIAGE_CUSTOM_HOME_HINT =
  "If you installed LastCode with a custom data folder, set T3CODE_HOME to that folder before running the command.";
