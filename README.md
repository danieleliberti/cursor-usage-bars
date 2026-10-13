# Cursor Usage Bars

Status bar: 3 colonnine (D−2 · ieri · oggi) + alert overage + click → dashboard usage.

## Local + Remote SSH

| Lato | Ruolo |
|---|---|
| **Local (UI)** | Legge il login Cursor → auth automatica; sync token nel workspace |
| **SSH (workspace)** | Mostra l’estensione sul remote e usa il token syncato |

Vedi `INSTALL.md`.

## Auth

1. Login Cursor sul PC  
2. UI legge `state.vscdb`  
3. Scrive `.cursor/usage-bars.accessToken` (gitignored)  
4. Lato SSH lo legge → status bar anche in remote  

## Licenza

MIT. Non affiliata a Cursor.
