# Setup Gates Frente G — Acciones manuales Isaac

## Gate G-2 · Wapify Pipeline (5 min)

1. Ir a: https://ap.whapify.ai
2. Login con cuenta del consultorio
3. Sección "Pipelines" → botón "+ Nuevo pipeline"
4. Nombre: `CITAS · AGENDA GIOCORE`
5. Copiar el ID numérico que genera (ej: 301234)
6. Ejecutar en terminal:
   ```bash
   cd ~/giolens_deploy
   npx vercel@latest env add WAPIFY_PIPELINE_CITAS production
   # Cuando pregunte el valor → pegar el ID numérico
   ```

## Gate G-1 · GCal Service Account (10 min)

### Si ya tienes el JSON descargado:
```bash
# 1. Pegar el contenido del JSON como env var en Vercel
cd ~/giolens_deploy
npx vercel@latest env add GCAL_SERVICE_ACCOUNT_JSON production
# Cuando pregunte → pegar el contenido completo del JSON en una sola línea

# 2. Añadir el Calendar ID
npx vercel@latest env add GCAL_CALENDAR_ID production
# Cuando pregunte → pegar el ID (formato: xxx@group.calendar.google.com)
```

### Si necesitas descargar el JSON:
1. https://console.cloud.google.com → proyecto GioLens (o crear)
2. IAM & Admin → Service Accounts → seleccionar la SA existente
3. Keys → Add Key → JSON → Download
4. Compartir el calendario con el email de la SA (rol: "Make changes to events")
5. Ejecutar los comandos de arriba

## Gate Vercel Auth · Token (2 min)

El auth.json de vercel CLI está vacío ({}). Necesitas autenticarte:
```bash
cd ~/giolens_deploy
npx vercel@latest login
# O si tienes un token:
npx vercel@latest env add VERCEL_TOKEN_DEPLOY preview
# Alternativa directa para deploy:
# VERCEL_TOKEN=<tu_token> npx vercel@latest --prod --yes
```

## Verificar después de añadir las 3 vars:
```bash
npx vercel@latest env ls production | grep -E "GCAL|WAPIFY_PIPELINE"
```
