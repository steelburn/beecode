# Bundled Python runtime

beeCode ships its own Python so the agent never has to tell the user "Python is not
installed". The payload is not committed — `scripts/fetch-python.mjs` vendors it:

```bash
npm run python:fetch          # downloads the pinned full CPython build (pip + venv)
npm run python:fetch -- --force --version 3.12.10
```

What lands here (Windows only; macOS and Linux use the system interpreter):

| Path | Purpose |
| --- | --- |
| `python.exe`, `pythonXYZ.dll`, `vcruntime140*.dll` | the interpreter and the VC runtime it links |
| `Lib\` | standard library, incl. `venv` and `ensurepip` (with its bundled pip wheel) |
| `Lib\site-packages\pip` | pip as a module — `python -m pip`; the payload ships no `pip.exe` |
| `DLLs\` | extension modules (`_ssl`, `_sqlite3`, `_socket`, …) |
| `include\`, `libs\` | headers and import libraries, for building C extensions |
| `python3.cmd`, `py.cmd`, `pip.cmd`, `pip3.cmd` | shims, because the payload only has `python.exe` |
| `BUNDLED.txt` | version, download URL, licence and fetch date |

This is the NuGet `python` package, not python.org's "embeddable" zip: embeddable has no
`ensurepip` (so `python -m venv .venv` fails with "ensurepip is not available") and its
`._pth` file switches off `import site` (so pip installs stay invisible). The full layout
keeps `venv` and `ensurepip`, stays relocatable — `sys.prefix` follows `python.exe`, which is
what lets it live under `resources/` — and `scripts/fetch-python.mjs` verifies all three
promises after copying (`--version`, `import venv, ensurepip`, `-m pip --version`).

Project dependencies belong in a workspace venv (`python -m venv .venv`), not here:
`src/service/python.ts` exports `PYTHONNOUSERSITE=1` to children so the machine's per-user
site-packages cannot shadow the bundled `pip`.

`electron-builder.yml` copies this folder to `<app>/resources/python` (outside the asar,
which cannot be executed). `src/service/python.ts` finds it, prepends it to the `PATH` of
every child process it starts and falls back to an OS interpreter when the folder is
absent — so a `npm run package` without a fetch still works on a machine that has Python.

Resolution rules live in `src/service/executables.ts`; both modules are covered by
`src/service/python.test.ts` and `src/service/executables.test.ts`.
