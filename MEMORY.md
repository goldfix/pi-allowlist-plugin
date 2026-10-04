# MEMORY.md — Memoria del Progetto

## Contesto rapido (leggere per primo)
- Progetto: estensione **Pi** `allowlist-gate` (pacchetto `pi-allowlist-plugin`), porting del plugin
  OpenCode che sta in `source_app/opencode-allowlist-plugin/` (reference **read-only**, mai modificare).
- Stack: TypeScript strict, **nessun build** (jiti in Pi; `node --test` con type-stripping nei test).
- Comando di verifica: `npm run check` (typecheck + test). Nella shell `node`/`npm` non sono nel PATH:
  `export PATH="/c/tc/Program/pi_agent/node:$PATH"` (Node v26.4.0 del bundle pi).
- Docs Pi locali: `C:\tc\Program\pi_agent\` (`docs/*.md`, `examples/extensions/`). Tipi ufficiali:
  scaricati con `npm pack @earendil-works/pi-coding-agent` in `/tmp/pi-types/package/dist/`
  (file chiave: `core/extensions/types.d.ts`, `utils/paths.js`, `core/tools/*.d.ts`).
- Stato: implementazione completa e rivista, **92 test verdi**, README compilato. Non ancora provata in un
  Pi reale (regola: non lanciare `pi` da qui — lo fa l'utente).

## Sessione 1 — avvio progetto (sintesi)
- La cartella era la copia del progetto OpenCode; `AGENTS.md`/`MEMORY.md`/`README.md` erano stub.
- Scelta **TypeScript** (preferenza utente + pi carica `.ts` via jiti + tipi ufficiali). Vincoli: solo sintassi
  erasable, import con `.ts` esplicito, `allowImportingTsExtensions` + `noEmit`.
- Layout da Pi package: `extensions/allowlist-gate/…` (nessun manifest `pi` necessario).
  `@earendil-works/pi-coding-agent` in `peerDependencies:"*"` + pinned (1.0.2) in `devDependencies`.
- Mapping OpenCode → Pi: niente `allow/ask/deny` nativi → `tool_call` + `{block, reason}` + `ctx.ui.select`
  ("Allow once" / "Allow for session" / "Deny"; senza UI blocco fail-safe); `shell:` = bash+powershell,
  `edit:` = edit+write, `mcp:<server>` su `mcp__<server>__<tool>`; niente monadi `webfetch/websearch`
  (non built-in in Pi); config da JSON (globale `<agent-dir>/extensions/`, progetto `<cwd>/.pi/`) + env
  `ALLOWLIST_GATE_*` (stessi nomi dell'originale).

## Sessione 2 — revisione completa, bug fix, documentazione

### Confronto di parità con `source_app` (esito)
Portato: wildcard (`*`,`?`, shorthand ` *`), parseRule, deny>allow>ask, allow=TUTTI i segmenti / deny=QUALSIASI,
redirezioni `>` sempre ask, boundary fuori-progetto sempre ask (solo deny lo blocca), MCP per-server,
default allow identici, env identiche, "always" senza effetto persistente, passthrough read-only.
Differenze volute: niente `webfetch/websearch`; niente azione `external_directory` (controllo nell'entry);
`question` nel passthrough come in origine; aggiunti `codemode`/`tool_search` (vedi sotto).
**Decisione utente (sessione 2):** in OpenCode `external_directory` chiedeva anche per le **letture** fuori
progetto; qui `read/grep/find/ls` NON sono gated, nemmeno fuori progetto. Motivo: il rischio che interessa
sono le operazioni dispositive e le chiamate a servizi esterni (MCP, ecc.) con impatto su effetti/costi; le
letture non sono un problema. Divergenza voluta, documentata nel README. (Se mai servisse: `classifyPath` sul
`path` di read/grep/find/ls + `forceAsk`; attenzione al `glob` di grep e alla necessità di una regola `read:`.)
**Decisione utente:** `codemode` e `tool_search` restano in passthrough (le chiamate annidate sono gated).

### Bug trovati e corretti (tutti con test di regressione)
1. **Bypass dello splitter** (grave): i separatori dentro `$(…)`/backtick non venivano splittati
   (`echo $(git status; rm -rf x)` passava come un segmento solo); `echo "$(rm -rf x)"` eseguiva la
   sostituzione dentro le virgolette non vista; `echo \"a; rm -rf x` (virgoletta escapata) veniva inghiottita.
   → `splitCommands` riscritto come scanner ricorsivo (vedi AGENTS §4), con dialetto `posix`/`powershell`
   (in PowerShell `\` non è escape e il backtick lo è: `"C:\dir\"; rm` doveva splittare). Invariante: solo
   over-split, mai under-split. Anche `( … )` splittano.
2. **Bypass fuori-progetto**: `resolve(cwd, "~/.bashrc")` lo dava "dentro il progetto" ma Pi espande `~`,
   `@`, `file://`, `/c/…`. → nuovo `paths.ts` che replica `resolvePath` dell'host.
3. **Risorsa edit non normalizzata**: `./.env`, `src/../.env`, percorsi assoluti aggirano le deny relative.
   → le regole `edit:` ora vedono il path relativo al progetto con `/` (assoluto se fuori).
4. **Approvazioni di sessione**: set a livello di modulo (sopravviveva a `/new`, reload) → ora dentro la
   factory e svuotato su `session_start`; il ramo fuori-progetto ignorava "Allow for session" → ora unico
   percorso `evaluate(..., {forceAsk})`; il ramo fuori-progetto usava `evaluate("edit")` ignorando regole `write`.
5. **Dialoghi concorrenti**: Pi esegue tool call in parallelo → coda seriale + ricontrollo del set di sessione
   dentro la coda (3 chiamate identiche → 1 dialogo); passato `ctx.signal` alla `select`.
6. **Config**: file di progetto letto anche se il progetto non è trusted (un repo clonato poteva auto-permettersi
   tutto) → ora solo con `ctx.isProjectTrusted()`; file JSON invalido = prima defaults (fail-open sulle deny),
   ora `{allow:[]}` + warning (notify una sola volta); `console.error` rimosso (sporcava la TUI).
7. `wildcardMatch` case-insensitive su Windows (parità con core; serve per deny tipo `edit:.env*`).
8. Test: `process.env = copia` rompeva l'env case-insensitive di Windows → ripristino per chiave; tmp dir ripulite.

### Decisioni di design nuove
- `codemode` e `tool_search` in `SAFE_PASSTHROUGH`: sandbox senza fs/rete, le chiamate annidate rientrano in
  `tool_call` (con `parentToolCallId`) e sono gated singolarmente; altrimenti ogni script chiederebbe due volte.
  (Riserva: `models.generateImages` spende token/soldi senza conferma — accettato, da rivalutare.)
- `evaluate(tool, resources, lists, { forceAsk })`: deny → forceAsk → redirezione → allow → passthrough → ask.
- Config riletta a ogni `tool_call` (modifiche live, costo trascurabile).
- Rimossa la cartella `scripts/` (install/uninstall erano di OpenCode; `pi install <path>` / `pi -e` bastano)
  e la cartella `src/` vuota; `.gitignore` reintitolato; `prepublishOnly` = `npm run check`.
- `npm pack --dry-run`: 7 file (LICENSE, README, package.json, 4 file in `extensions/allowlist-gate/`), ~13 kB.

### Limiti noti (documentati nel README)
Wrapper non "scartati" (`bash -c`, `sudo`, `env`, `xargs`, `eval`, script block); path assoluti esterni dentro
comandi in-progetto; symlink interni che puntano fuori; regole con pattern su tool generici non matchano mai;
letture fuori progetto non gated (scelta voluta).

### File toccati
`extensions/allowlist-gate/{index,policy,paths,config}.ts`, `test/{policy,paths,config,gate}.test.ts`,
`package.json` (script test + prepublishOnly), `tsconfig.json`, `.gitignore`, `README.md` (compilato, inglese),
`AGENTS.md` (riscritto), `MEMORY.md`.

## Prossimi passi
1. Prova live in Pi reale (`pi -e ./extensions/allowlist-gate`) — a cura dell'utente — e iterare sul testo del dialogo
   (verificare in particolare: dialoghi con comandi lunghi/multilinea, `ctx.signal` su abort, comportamento di
   `session_start` con `reload`).
2. Valutare un comando `/allowlist` (mostra config effettiva/warning, simula una decisione).
3. Prima della pubblicazione: impostare `repository`/`homepage`/`bugs` in `package.json` (URL GitHub ignoto),
   verificare che il nome npm `pi-allowlist-plugin` sia libero, `npm pack --dry-run`; `npm publish` è comando dell'utente.
4. `package-lock.json` è stato generato da `npm install` (decidere se versionarlo; `.gitignore` non lo esclude).

## Sessione 3 — preparazione npm/GitHub
- Nome `pi-allowlist-plugin` verificato libero su npm (404 dal registry).
- Package pronto: `npm run check` verde (92 test), `npm pack --dry-run` = 7 file, ~13,5 kB.
- `repository`/`homepage`/`bugs` NON inseriti (URL GitHub ignoto): snippet pronto da aggiungere.
- Git repo + push + `npm publish` a cura dell'utente. `package-lock.json`: proposto di versionarlo.
