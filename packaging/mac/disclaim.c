// net-disclaim: exec a command as its own "responsible process".
//
// macOS Local Network privacy checks the responsible process of a connection,
// which for ssh spawned by the app is the app itself. An ad-hoc signed app never
// gets the permission prompt and is silently denied (EHOSTUNREACH). Disclaiming
// makes /usr/bin/ssh responsible for itself, and command-line tools are not
// subject to Local Network privacy, the same as ssh run from a terminal.
//
// POSIX_SPAWN_SETEXEC replaces this process, so the caller's pid, stdio and
// signals go straight to the command. Built by `npm run dist:mac`.
#include <spawn.h>
#include <stdio.h>

extern char **environ;
// Private but stable libSystem API (used by Terminal, iTerm, VS Code).
int responsibility_spawnattrs_setdisclaim(posix_spawnattr_t *attrs, int disclaim);

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: net-disclaim command [args...]\n");
    return 64;
  }
  posix_spawnattr_t attrs;
  posix_spawnattr_init(&attrs);
  posix_spawnattr_setflags(&attrs, POSIX_SPAWN_SETEXEC);
  responsibility_spawnattrs_setdisclaim(&attrs, 1);
  posix_spawnp(NULL, argv[1], NULL, &attrs, argv + 1, environ);
  perror(argv[1]); // only reached if the exec failed
  return 127;
}
