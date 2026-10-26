# @open-agent/tools-vision

`view_image`: asks a vision model about an image — a screenshot, a chart, a diagram, a photo of a page — and returns its answer, so the agent can read pictures even though `LlmAdapter` carries text.

```ts
import { viewImageTool } from '@open-agent/tools-vision'

tools.register(
  viewImageTool({
    baseURL: 'https://api.openai.com/v1',
    apiKey,
    model: 'gpt-4o',
    root: workspace.root,
    policy: workspace.policy,
  }),
)
```

## The tool

`{ image, question? }`. `image` is a path in the workspace or an http(s) URL, and must be PNG, JPEG, WebP or GIF, up to 10 MB. Without `question` the model is asked for a detailed description, including any text in the image. The image is sent as a data URL in an OpenAI-style `image_url` message to `<baseURL>/chat/completions` — the endpoint the agent already uses — and the model's reply is the result. An endpoint that refuses (usually a model that cannot see) is reported with the model's name.

## Safety

- **`safe`.** It reads only what the agent can already reach and sends it to the provider that already sees the whole conversation.
- **Workspace images follow the file policy**, like `read_file`: an image the policy denies is refused. With no workspace configured, only URLs are accepted.
- **Image URLs follow the network policy**, through the same `createGuardedFetch` as `fetch_url`: local and private addresses are refused, and every redirect is vetted.
- **The answer is untrusted output.** Text in an image is whatever its author put there, instructions included, so it is fenced and the task stops being covered by remembered approvals.

In the CLI: `VISION_TOOL=1`, with `VISION_MODEL` naming a model on `OPENAI_BASE_URL` that can see (default `OPENAI_MODEL`). Workspace images are available when the file, shell or git tools have set a workspace up; vision alone grants no file access.
