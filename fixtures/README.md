# HTML fixture provenance

The HTML files under `htmlagenda/` and `soleon/tenant-scan/` are reduced,
manually retained samples of observed pages used for parser contracts. They are
not complete page archives: unrelated layout, scripts, navigation and sometimes
cards were removed. New SOLEON capture fixtures are not full archives. The
Marco/DCM detail fixtures record the observed URL, UTC capture time and SHA-256
of the original response in their HTML comments; other fixtures have no such
provenance metadata. Do not treat any fixture as a complete catalog or current
state evidence.

## vlance/

`vlance/jdleiloes-franciscofreitas-recortes.json` holds four trimmed JSON items
(cut from raw public `POST /core/api/get-lotes` responses on 2026-10-13T18:15Z:
1 imóvel and 1 veículo from jdleiloes.com.br, 1 "Animais" item from jdleiloes
and 1 divergent-owner item from franciscofreitasleiloes.com.br). Photos and
attachments are truncated to two entries and licitante fields
(`nm_usuario`/`id_usuario`) were removed. The file records the request URL, UTC
capture time, HTTP status and SHA-256 of each original response body, plus the
per-`tipo` counts measured the same day. Not a complete catalog archive.

