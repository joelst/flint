---
"flint": patch
---

Fix image requests, which could not reach a model. Merging or prefixing a vision turn interpolated its content array into a string, sending `[object Object]` and dropping the image; the multipart form that survived was then rejected by the SDK's chat client, which accepts only string content. Multipart requests now take the OpenAI-shaped HTTP endpoint, and turns are merged structurally. Text split across parts is no longer re-indented or re-spaced on its way to the model.
