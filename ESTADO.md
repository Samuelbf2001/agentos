# ESTADO — feat/notas-foto

**Objetivo:** en Notas a mano, botón «Foto» (tomar con el celular o subir imagen) para fotos del tablero de la oficina; la foto entra al lienzo y pasa por la misma transcripción.

## Hecho (2026-09-23)
- 6ed3bbb API: las imágenes del lienzo son región propia en la segmentación (`esFoto`); prompt con sección «Fotos»; PATCH de escena con bodyLimit ~30 MB (las fotos viajan en `files`).
- 3e2c908 Web: botón «Foto» (menú Tomar foto / Subir imagen, cabecera y pantalla completa), `foto.ts` (reduce a ≤2000 px JPEG 0.85 respetando EXIF, posición a la derecha de lo existente), `insertarFoto`, encadena el mismo «Transcribir».
- 510ba6d Web: el menú se cierra al tocar fuera o con Esc.
- Suite completa verde (1364 tests), typecheck limpio.
- Verificado en sandbox (:4310/:4311): foto → lienzo → guardado 200 → captura 201 → PNG correcto. La lectura no se probó en local (sandbox sin ANTHROPIC_API_KEY → 502 esperado).

## Falta
- Merge a master + deploy api y web (fuera de horario laboral o con permiso de Ernesto).
- Prueba real en producción con una foto del tablero.
- Riesgo: la escena guarda las fotos en base64; muchas fotos grandes en una nota → filas pesadas y autoguardado lento.
