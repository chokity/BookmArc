export default {
  ignoreFiles: [
    ".env",
    ".amo-upload-uuid",
    ".gitignore",
    "scripts",
    "extras/setup",
    "docs",
    // Documentation, not used by the add-on: left out so a change to it after
    // signing doesn't stop scripts/release.sh (it compares the build file by file).
    "README.md",
    "CHANGELOG.md",
    "updates.json",
    "sign.sh",
    "package.json",
    "package-lock.json",
    ".web-ext-config.mjs",
    "node_modules",
    "web-ext-artifacts",
  ],
};
