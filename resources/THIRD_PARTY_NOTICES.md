# Third-party notices

Second Brain is released under the MIT license (see LICENSE). It includes or downloads the following software and models, each under its own license.

## Included in the app

| Component | License | Notes |
| --- | --- | --- |
| [Electron](https://www.electronjs.org) and Chromium | MIT, plus the Chromium licenses | The licenses of Chromium's components ship with the app (`LICENSES.chromium.html`). |
| [llama.cpp](https://github.com/ggml-org/llama.cpp) (`llama-server`, release b11756) | MIT | Runs the built-in model. Its license is next to the binaries, in `llama/<platform>/LICENSE`. |
| [LLVM OpenMP runtime](https://openmp.llvm.org) (`libomp.dll`, Windows only) | Apache-2.0 with LLVM exceptions | Used by llama.cpp's CPU backend; license in `llama/win-x64/LICENSE-LLVM-OpenMP`. |
| [three.js](https://threejs.org) | MIT | 3D rendering. |
| [d3-force-3d](https://github.com/vasturiano/d3-force-3d) | MIT | Graph layout. |
| [marked](https://marked.js.org), [marked-katex-extension](https://github.com/UziTech/marked-katex-extension) | MIT | Markdown rendering. |
| [KaTeX](https://katex.org) | MIT | Math rendering. |
| [DOMPurify](https://github.com/cure53/DOMPurify) | Apache-2.0 or MPL-2.0 | HTML sanitising. |
| [yaml](https://eemeli.org/yaml) | ISC | Frontmatter parsing. |
| [zod](https://zod.dev) | MIT | Data validation. |
| [Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk) and its dependencies | MIT, ISC, BSD-2-Clause, BSD-3-Clause | The MCP server for other apps. |

## Downloaded on request

The built-in agent's models are not part of the installer. They are downloaded from Hugging Face only when you choose them (in the first-run setup or in the agent settings) and stored in the app's data folder.

| Model | License | Source |
| --- | --- | --- |
| Qwen 3.5 4B and Qwen 3.5 9B, by the Qwen team (Alibaba Cloud), with their vision projectors | Apache-2.0 | GGUF quantizations by [Unsloth](https://huggingface.co/unsloth) |

## Demo vault

The demo vault was written for Second Brain and is covered by the app's MIT license.
