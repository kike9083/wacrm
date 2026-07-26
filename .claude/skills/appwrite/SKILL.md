---
name: appwrite
description: |
  Todo lo relacionado con Appwrite: crear collections, gestionar documentos, permisos, queries, metricas, CRUD,
  auth, storage, y operaciones de datos.
  Activar cuando el usuario dice: necesito una collection, crear collection, base de datos, guardar datos,
  proteger datos, permisos, query, cuantos usuarios, metricas, revenue, dame los datos,
  consulta appwrite, cuantos registros, analiza los datos, estadisticas, reportes, churn,
  funnel, storage, auth, configurar permisos, o cualquier operacion de BD.
allowed-tools: Bash(curl *) Bash(export *) Bash(grep *) Bash(python3 *) Read, Write, Edit, Grep
metadata:
  author: saas-factory
  version: "1.0"
---

# Appwrite — Tu Backend Completo

Collections, documentos, permisos, auth, storage, y metricas. Todo desde el SDK.

---

## Setup Inicial (Una Sola Vez)

### Paso 1: Credenciales

Encuentra en Dashboard → tu proyecto → Settings:
- **API Key** → Settings → API Keys → Create API Key (con permisos databases)
- **Project ID** → Settings → Project ID
- **Endpoint** → Settings → API Endpoint
- **Database ID** → Databases → tu database → ID

### Paso 2: Guardar en `.env.local`

```bash
NEXT_PUBLIC_APPWRITE_ENDPOINT=https://cloud.appwrite.io/v1
NEXT_PUBLIC_APPWRITE_PROJECT_ID=tu_project_id
APPWRITE_API_KEY=standard_xxxxx
APPWRITE_DATABASE_ID=tu_database_id
```

---

## Cargar Credenciales (Antes de Cualquier Query)

```bash
export APPWRITE_ENDPOINT=$(grep '^NEXT_PUBLIC_APPWRITE_ENDPOINT=' .env.local | cut -d= -f2)
export APPWRITE_PROJECT_ID=$(grep '^NEXT_PUBLIC_APPWRITE_PROJECT_ID=' .env.local | cut -d= -f2)
export APPWRITE_API_KEY=$(grep '^APPWRITE_API_KEY=' .env.local | cut -d= -f2)
export APPWRITE_DATABASE_ID=$(grep '^APPWRITE_DATABASE_ID=' .env.local | cut -d= -f2)
```

---

## REST API: Explorar Estructura

### Listar Databases

```bash
curl -s "$APPWRITE_ENDPOINT/databases" \
  -H "X-Appwrite-Project: $APPWRITE_PROJECT_ID" \
  -H "X-Appwrite-Key: $APPWRITE_API_KEY" | python3 -c "import sys,json; d=json.load(sys.stdin); [print(f'{db[\"name\"]} | {db[\"\$id\"]}') for db in d.get('databases', [])]"
```

### Listar Collections

```bash
curl -s "$APPWRITE_ENDPOINT/databases/$APPWRITE_DATABASE_ID/collections" \
  -H "X-Appwrite-Project: $APPWRITE_PROJECT_ID" \
  -H "X-Appwrite-Key: $APPWRITE_API_KEY" | python3 -c "import sys,json; d=json.load(sys.stdin); [print(f'{c[\"name\"]} | {c[\"\$id\"]}') for c in d.get('collections', [])]"
```

### Ver Atributos de una Collection

```bash
curl -s "$APPWRITE_ENDPOINT/databases/$APPWRITE_DATABASE_ID/collections/COLLECTION_ID/attributes" \
  -H "X-Appwrite-Project: $APPWRITE_PROJECT_ID" \
  -H "X-Appwrite-Key: $APPWRITE_API_KEY" | python3 -c "import sys,json; d=json.load(sys.stdin); [print(f'{a[\"key\"]}: {a[\"type\"]}') for a in d.get('attributes', [])]"
```

---

## REST API: CRUD

### Listar Documentos

```bash
curl -s "$APPWRITE_ENDPOINT/databases/$APPWRITE_DATABASE_ID/collections/COLLECTION_ID/documents" \
  -H "X-Appwrite-Project: $APPWRITE_PROJECT_ID" \
  -H "X-Appwrite-Key: $APPWRITE_API_KEY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Total: {d[\"total\"]} documentos')"
```

### Crear Documento

```bash
curl -s -X POST "$APPWRITE_ENDPOINT/databases/$APPWRITE_DATABASE_ID/collections/COLLECTION_ID/documents" \
  -H "X-Appwrite-Project: $APPWRITE_PROJECT_ID" \
  -H "X-Appwrite-Key: $APPWRITE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "documentId": "unique()",
    "data": {"campo": "valor"}
  }'
```

### Actualizar Documento

```bash
curl -s -X PATCH "$APPWRITE_ENDPOINT/databases/$APPWRITE_DATABASE_ID/collections/COLLECTION_ID/documents/DOCUMENT_ID" \
  -H "X-Appwrite-Project: $APPWRITE_PROJECT_ID" \
  -H "X-Appwrite-Key: $APPWRITE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"data": {"campo": "nuevo_valor"}}'
```

### Eliminar Documento

```bash
curl -s -X DELETE "$APPWRITE_ENDPOINT/databases/$APPWRITE_DATABASE_ID/collections/COLLECTION_ID/documents/DOCUMENT_ID" \
  -H "X-Appwrite-Project: $APPWRITE_PROJECT_ID" \
  -H "X-Appwrite-Key: $APPWRITE_API_KEY"
```

---

## Crear Collection con Permisos

```bash
# 1. Crear collection
COLLECTION_ID=$(curl -s -X POST "$APPWRITE_ENDPOINT/databases/$APPWRITE_DATABASE_ID/collections" \
  -H "X-Appwrite-Project: $APPWRITE_PROJECT_ID" \
  -H "X-Appwrite-Key: $APPWRITE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"collectionId": "unique()", "name": "profiles", "documentSecurity": true}' | \
  python3 -c "import sys,json; print(json.load(sys.stdin)['\$id'])")

# 2. Agregar atributos (string)
curl -s -X POST "$APPWRITE_ENDPOINT/databases/$APPWRITE_DATABASE_ID/collections/$COLLECTION_ID/attributes/string" \
  -H "X-Appwrite-Project: $APPWRITE_PROJECT_ID" \
  -H "X-Appwrite-Key: $APPWRITE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"key": "user_id", "size": 36, "required": true}'

# 3. Crear indice
curl -s -X POST "$APPWRITE_ENDPOINT/databases/$APPWRITE_DATABASE_ID/collections/$COLLECTION_ID/indexes" \
  -H "X-Appwrite-Project: $APPWRITE_PROJECT_ID" \
  -H "X-Appwrite-Key: $APPWRITE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"key": "idx_user_id", "type": "key", "attributes": ["user_id"]}'
```

---

## Permisos (equivalente a RLS)

Roles: `any` (publico), `users` (autenticado), `user:USER_ID` (usuario especifico)

```bash
# Al crear documento con permisos:
"permissions": [
  "read(\"user:USER_ID\")",
  "update(\"user:USER_ID\")",
  "delete(\"user:USER_ID\")"
]
```

---

## Principios

1. **Permissions Siempre**: Todo documento de usuario con `documentSecurity: true`
2. **REST API para scripting**: curl + python3
3. **SDK para produccion**: `node-appwrite` server-side, `appwrite` client-side
4. **API Key solo server**: Nunca enviar al cliente
5. **Verificar con queries reales**: No confiar en docs viejos

---

## Flujo de Trabajo

1. Cargar credenciales (export)
2. Listar collections (explorar estructura)
3. Crear/modificar documentos (REST API)
4. Verificar permisos y indices
5. Testear datos reales
