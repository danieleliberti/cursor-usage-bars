# Installazione — Local + Remote SSH

L’estensione è `ui` + `workspace`: deve stare **su entrambi** i lati.

## 1) Locale (obbligatorio per auth automatica)

1. Scarica `cursor-usage-bars-0.3.0.vsix` sul PC  
2. `Ctrl+Shift+P` → **Extensions: Install from VSIX…** → file scaricato → **Local**  
3. Reload Window  

Dopo il login Cursor sul PC, il token si legge da solo e la status bar compare anche nelle finestre SSH.

## 2) Remote SSH (per vederla sotto “SSH: host”)

Sul remote (ops-compute):

```bash
cursor --install-extension /deploy/cursor-usage-bars-0.3.0.vsix --force
```

Oppure Install from VSIX scegliendo **SSH**.

## Come funziona l’auth in SSH

1. Lato **Local (UI)**: legge il login Cursor da `state.vscdb`  
2. Scrive (auto) `.cursor/usage-bars.accessToken` nel workspace remoto  
3. Lato **SSH (workspace)**: legge quel file e mostra le colonnine  

Niente cookie da incollare. Il file viene aggiunto a `.gitignore` se presente.

## Verifica

- Estensioni → **Local**: Cursor Usage Bars  
- Estensioni → **SSH: …**: Cursor Usage Bars  
- Status bar: `▃▅█ $x.xx`  
- Comando: **Cursor Usage Bars: Auth Status**
