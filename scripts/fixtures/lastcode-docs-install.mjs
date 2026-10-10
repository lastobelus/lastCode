#!/usr/bin/env node

process.stderr.write(
  "The public-documentation fixture does not install applications. Capture only inspect and build states.\n",
);
process.exitCode = 1;
