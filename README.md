# Gestão Coleção BG — V1.4

PWA multi-dispositivo da Gestão Coleção BG.

- App pública: https://schmaull10.github.io/gestao_colecao_bg/
- Código da app neste repositório.
- Os dados pessoais da coleção **não** ficam neste repositório público.
- A base `colecao.json` é lida/escrita num repositório privado separado através de um fine-grained GitHub token guardado localmente em cada dispositivo.

## Publicação

Extrair o pacote de deploy V1.4 e colocar na raiz da branch `main`:
`index.html`, `app.js`, `style.css`, `initial_data.js`, `manifest.webmanifest`, `sw.js`.

Na primeira abertura, configurar o token GitHub. Se ainda não existir `colecao.json` remoto, importar o `data/colecao.json` atual da versão desktop.
