export const PUBLICATION_CHECKS = [
  {
    kind: "command",
    label: "Check unused code",
    command: "vp",
    args: ["run", "knip:check"],
  },
  {
    kind: "command",
    label: "Check generated GitHub GraphQL operations",
    command: "vp",
    args: ["run", "--filter", "@t3tools/source-control-github", "generate", "--check"],
  },
  {
    kind: "command",
    label: "Check generated Expo GraphQL operations",
    command: "vp",
    args: ["run", "--filter", "t3", "generate", "--check"],
  },
] as const;
