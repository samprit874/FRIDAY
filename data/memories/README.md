# FRIDAY — Memory Backup System

Your AI memories are protected by an automatic versioned backup daemon.

## Architecture

| Component | Path | Description |
|---|---|---|
| **Primary Memory Store** | `%APPDATA%\FRIDAY\memories.json` or `./data/memories/memories.json` | Active recollections used by Friday |
| **Backup Sidecar** | `./data/memory_backup.cjs` | Background service keeping snapshots |
| **Versioned Snapshots** | `./data/memories/backups/` | Timestamped historical memory snapshots |

## Memory Protection Features
1. **Auto-Snapshots:** Creates safe snapshots whenever memories are updated.
2. **Auto-Recovery:** Silently restores previous memories if the primary store is corrupted or deleted.
3. **Local & Private:** Memories remain 100% stored on your machine and are never shared.
