# JovidxonChat

Сервер ва панели админи мессенҷери JovidxonChat (барномаи Android алоҳида аст).

| Папка | Чӣ |
| --- | --- |
| [`Backend/`](Backend/README.md) | API + WebSocket: Node.js (Fastify) + PostgreSQL; ҳуҷҷати API — [`Backend/docs/API.md`](Backend/docs/API.md) |
| [`admin_panel/`](admin_panel/) | панели админ (React), дар `/admin/`-и ҳамон сервер |
| [`render.yaml`](render.yaml) | Render Blueprint: web service + базаи PostgreSQL |

Насб дар Render: [`setup.md`](setup.md). Калидҳои махфӣ (SMS ва ғ.) дар репозиторий нестанд — онҳо дар Render → Environment ворид карда мешаванд.
