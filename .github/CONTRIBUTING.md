# Contributing

Contributions should stay within the repository's current supported boundary: Apple Silicon, macOS 14 or later, and Zsh.

Before opening a change:

1. Explain the user-visible problem and keep the solution to the smallest coherent change.
2. Preserve user-owned configuration and never add credentials, personal paths, generated caches, or private provider settings.
3. Update the single authoritative document when behavior, interfaces, or workflows change.
4. Run the narrowest relevant checks. For the current top-level setup behavior, use:

   ```bash
   bash -n setup
   bun run test
   ```

Include the commands and raw results in the pull request. Do not broaden platform support or add dependencies without evidence that the existing toolchain cannot solve the problem.
