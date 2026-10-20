# Social Studio V7 — Publicación automática Meta

## Incluye
- `index.html` — base real V6 con todas sus pantallas, marcas, calendario y Supabase.
- `v7-ui.js` — nueva pantalla «Publicación automática» con conexión Meta, programación, estados y cancelación.
- `supabase/migrations/20261020_v7.sql` — conexiones cifradas y cola de publicaciones.
- `supabase/functions/meta-api/index.ts` — OAuth de Meta, listado de cuentas y programación validada.
- `supabase/functions/meta-worker/index.ts` — ejecución programada para Facebook e Instagram.
- `supabase/config.toml` — callback OAuth y cron con validación específica.

## 1. Respaldo e instalación SQL
Exporta tus publicaciones desde Social Studio y conserva copia de V6. Ejecuta primero `schema_v5.sql` si aún no lo hiciste. Luego ejecuta el archivo SQL de V7 en Supabase SQL Editor. No elimina tablas anteriores.

## 2. Aplicación Meta
Crea una aplicación en Meta for Developers con Facebook Login for Business (según opciones vigentes), solicita los permisos `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`, `instagram_content_publish` y configura la URL de redirección EXACTA:

`https://afpzcptwrdedrzuqdvhk.supabase.co/functions/v1/meta-api/callback`

Instagram debe ser una cuenta profesional vinculada a una Página de Facebook. Los permisos pueden requerir revisión de Meta y verificación empresarial para uso con clientes externos. Añade usuarios de prueba/roles mientras la app esté en desarrollo. Configura política de privacidad y eliminación de datos según requisitos de Meta.

## 3. Variables secretas de Supabase Edge Functions
Configura en Supabase (Edge Functions → Secrets o CLI) las siguientes variables **solo en el servidor**:

- `META_APP_ID`: ID de la app Meta
- `META_APP_SECRET`: secreto de la app Meta
- `META_STATE_SECRET`: cadena aleatoria de 32+ bytes para firmar el estado OAuth
- `META_TOKEN_KEY`: clave AES-GCM de 32 bytes codificada en base64 estándar
- `META_CRON_SECRET`: cadena aleatoria larga para autenticar el proceso automático
- `FRONTEND_URL`: `https://v4mp-ngly.github.io/Social-Studio/`
- `META_GRAPH_VERSION`: versión de Graph API soportada, por ejemplo `v23.0`; verifica vigencia en la documentación de Meta

`SUPABASE_URL`, `SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY` deben estar disponibles como secretos de proyecto en Edge Functions. **Nunca** los pongas en GitHub Pages, salvo la anon/public key ya usada por el cliente. No incluyas estos secretos en el ZIP ni en el repositorio.

Ejemplo para crear la clave AES con Python local: `python -c "import os,base64; print(base64.b64encode(os.urandom(32)).decode())"`.

## 4. Despliegue
Con Supabase CLI autenticada y enlazada al proyecto:

```bash
supabase functions deploy meta-api --no-verify-jwt
supabase functions deploy meta-worker --no-verify-jwt
```

El callback OAuth necesita acceso público; el resto de rutas de `meta-api` valida sesión Supabase. `meta-worker` exige `x-cron-secret`.

Sube **ambos** `index.html` y `v7-ui.js` a la raíz de tu repositorio GitHub Pages `Social-Studio`.

## 5. Ejecución periódica
Crea un trabajo programado en el panel de Supabase (Cron / pg_cron + pg_net) que invoque por POST cada minuto:

`https://afpzcptwrdedrzuqdvhk.supabase.co/functions/v1/meta-worker`

Incluye encabezado `x-cron-secret` con el valor de `META_CRON_SECRET`. **No escribas el secreto literal en SQL público ni en GitHub**; usa Supabase Vault/gestión de secretos o una herramienta externa segura de cron. El endpoint no se ejecuta solo por estar desplegado. Comprueba que el cron funciona con una publicación de prueba.

## 6. Pruebas recomendadas
1. Inicia sesión, abre una marca, entra a Publicación automática y conecta Meta.
2. Confirma que aparecen Página de Facebook y/o Instagram profesional.
3. Crea un post de Facebook, programa una fecha futura y revisa el historial.
4. Prueba Instagram con imagen pública HTTPS directa, y después Reel con URL directa de video compatible.
5. Verifica el resultado en Meta y en el historial. Prueba cancelar una publicación aún en cola.
6. Comprueba cambio de marcas, calendario, guardado, filtros y backups.

## Límites conocidos
- No publica carruseles, historias, Facebook Reels ni LinkedIn/TikTok en V7.
- Facebook admite texto e imágenes; Instagram admite imagen única y Reels con video accesible públicamente. Meta impone restricciones de formato, duración, permisos, tasas y procesamiento.
- Las publicaciones guardadas en V6 **no se envían automáticamente**: debes crear una programación en la pantalla V7.
- No se hace reintento automático de errores: un timeout después de que Meta haya aceptado el post podría producir duplicados si se reintenta. Revisa Meta antes de crear otro trabajo.
- Tokens de Meta están cifrados en reposo mediante clave AES de Edge Functions, pero aún hay que añadir desconexión, renovación/alertas de expiración y auditoría antes de un uso comercial amplio.
- V6 usa JSON por marca para los posts; la cola V7 usa tabla propia. Ediciones posteriores al post en V6 **no** actualizan un trabajo ya programado. Cancela y vuelve a programar.
- La programación usa la zona horaria local del navegador para interpretar fecha/hora y la almacena en UTC.
- **No se han realizado pruebas reales con credenciales Meta ni un despliegue en Supabase.**
