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
- Stato: implementazione completa e rivista, **95 test verdi**, README/AGENTS/MEMORY aggiornati. Non ancora
  provata in un Pi reale (regola: non lanciare `pi` da qui — lo fa l'utente).
- Repo git: remote `origin = git@github.com:goldfix/pi-allowlist-plugin.git`; branch `main` esistente.
  Al momento dell'ultima revisione il worktree era sul branch `task/small_improve` con modifiche non
  committate (git/commit/push e `npm publish` sono a cura dell'utente).

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

## Prossimi passi (aggiornato — sessione 8)
1. **Compact + verifiche di installazione** (a cura dell'utente): provare `pi install` da npm, git e percorso
   locale, poi `pi list` e `pi -e`; verificare che l'estensione carichi una sola volta e che il seed del config
   globale avvenga in `<agent-dir>/extensions/`.
2. Prova live dei dialoghi: comandi lunghi/multilinea, `ctx.signal` su abort, `session_start` con `reload`,
   messaggio di blocco senza UI (print/JSON mode).
3. Valutare un comando `/allowlist` (mostra config effettiva + warning, o simula una decisione).
4. Pubblicazione: `npm publish` (nome libero) e release/tag GitHub `v0.1.0` — comandi dell'utente.
5. `package-lock.json`: presente, non escluso da `.gitignore` (proposto di versionarlo).

## Sessione 3 — preparazione npm/GitHub
- Nome `pi-allowlist-plugin` verificato libero su npm (404 dal registry).
- Package pronto: `npm run check` verde (92 test), `npm pack --dry-run` = 7 file, ~13,5 kB.
- `repository`/`homepage`/`bugs` NON inseriti (URL GitHub ignoto): snippet pronto da aggiungere.
- Git repo + push + `npm publish` a cura dell'utente. `package-lock.json`: proposto di versionarlo.

## Sessione 4 — docs di installazione via Pi package
- Verificata la doc nativa di Pi (`pi install` da npm/git/locale, `-e` per provare, `pi list/remove/update`;
  i package di progetto richiedono project trust). Nessuna modifica al codice necessaria: la struttura
  convenzionale `extensions/allowlist-gate/` + keyword `pi-package` è già sufficiente.
- README: sezione Installation riscritta con i percorsi npm, GitHub (`<owner>` placeholder), checkout locale,
  prova senza installare, copia manuale e gestione dell'install. AGENTS §5 aggiornato di conseguenza.

## Sessione 5 — default allowlist estesa
- Aggiunti ai default `shell:wc *`, `shell:grep *`, `shell:tail *` (comandi read-only).
  Test config esteso (3 assert sui nuovi default), README aggiornato. Check verde (92 test).
- Nota da verificare in live: `shell:grep *` in allowlist rende meno rumoroso il gate ma non copre
  l'uso via tool `grep` built-in (che è in passthrough comunque).

## Sessione 6 — seed automatico del config globale
- Richiesta: l'utente deve trovarsi `allowlist-gate.json` già pronto nella conf di Pi.
- Implementato `ensureGlobalConfigFile()` in `config.ts`: alla prima `tool_call`, se il file globale
  manca, lo crea con i default incorporati (`{enabled:true, allow:[...DEFAULT_ALLOW], deny:[]}`).
  Mai sovrascritto; creazione atomica (`wx`) per le tool call parallele; saltato quando env
  (`ALLOWLIST_GATE_ALLOW/DENY/ENABLED=0`) già configura il gate, per non oscurare il fallback env.
  Chiamato all'inizio dell'handler in `index.ts` (warning in testa a `config.warnings` se fallisce).
- Test: 3 in `config.test.ts` (seed, no-overwrite, skip env) + 1 in `gate.test.ts` (seed on first use)
  e adeguato il test "disabled gate" (non deve creare nulla). Totale 96 test verdi.
- README (nota nella sezione Configuration) e AGENTS §4 aggiornati.

## Sessione 7 — rimozione variabili di ambiente
- Richiesta: alleggerire l'implementazione, config solo da file JSON.
- Rimosso da `config.ts`: parametro `env` di `resolveConfig`/`loadConfig`/`ensureGlobalConfigFile`,
  funzioni `toStringList`/`toBool` semplificate (solo JSON), niente più letture di `process.env`
  (l'handler non lo tocca più). Seed del file globale ora incondizionato (a parte file esistente).
- Test: `config.test.ts` riscritto senza env (resolveConfig solo JSON, tolto il test skip-env);
  `gate.test.ts`: ENV_KEYS ridotto a `PI_CODING_AGENT_DIR`, test "disabled gate" via file
  (`{enabled:false}`) invece che env. Totale 95 test verdi.
- README (sezione Configuration senza env), AGENTS §3-§4 aggiornati.

## Sessione 8 — revisione finale + metadati repo
- Verifica completa di codice/test/docs: `npm run check` verde (**95 test, 26 suite**); `npm pack --dry-run`
  = 7 file (~14 kB). Nessun riferimento a env rimasto in `extensions/` (resta `PI_CODING_AGENT_DIR` nei test,
  che è una env dell'host per `getAgentDir()`).
- Scoperto il repo git (creato dall'utente): remote `git@github.com:goldfix/pi-allowlist-plugin.git`
  (branch `main`; worktree su `task/small_improve`). Sostituiti i placeholder `<owner>` con `goldfix` nel README
  e impostati `repository`/`homepage`/`bugs` in `package.json`. AGENTS §5 aggiornato.
- Fix minori: README (riga di struttura `config.ts` non più "JSON + env"), commento obsoleto in `gate.test.ts`.
- NB: la nota della sessione 6 sul "seed saltato con env" è storica: dalla sessione 7 il seed è incondizionato.
