# Model-car redraw workflow

Use this workflow only for models the owner explicitly selects for AI redraw. The original-photo default still applies elsewhere. Approval of a finished batch is separate from permission to generate the next batch.

## Reference and generation

1. Select exact stable IDs from `src/data/library/model-cars.json`. Save the complete starting payload, selected records and exact reference images outside this public repo under `../Drafts/`.
2. Inspect every reference image. Record the manufacturer, SKU, scale, color, race number, wheels, included accessories and selected open-panel configuration. Similar models from different manufacturers remain separate. Preserve the owner's chosen view and parts.
3. Use the built-in OpenAI `image_gen` tool with one exact reference and one model-specific prompt per output. Save prompts, outputs and reference provenance in the draft folder. Keep the original generated output when copying it into that folder.
4. The approved studio treatment uses a single three-quarter view, a 3:2 landscape canvas (1536 × 1024), a white seamless background and soft contact shadow. Frame the complete subject generously without clipping mirrors, wings, open parts, accessories or shadows. Tall toys and genuine multi-part sets need different framing from ordinary cars. Preserve miniature proportions and materials.
5. State each model's invariants explicitly in the prompt. Specify every panel that should be open or closed. Include the trailer, scooter, loose body panels or figure when they belong to the selected set. Keep livery and numbers, and do not turn a toy into a full-size automobile.
6. Inspect every full output against its reference. Generated lettering and geometry are interpretations, not documentary proof. Correct missing parts, wrong liveries, clipped subjects or an incorrect open-panel configuration before review.

For background variants, generate the complete model first, then use that accepted output as the edit target for background removal. Request actual alpha transparency from `image_gen`; a white or checkerboard image is not transparency. Preserve the alpha channel and check edges over light and dark surfaces. Keep variants separate until the owner selects the displayed version.

## Records and assets

1. Update the owner's canonical record store before preparing the blog payload. Retain original source URLs, source filenames, status facts and historical evidence. Track the destination as prepared until deployed and verified.
2. Save generated assets outside the repository and upload them through `scripts/images/config.mjs` and `scripts/images/r2.mjs`. Use immutable keys such as `library/model-cars/<id>-ai-redraw-<sha256-prefix>.png`. Preserve alpha for transparent variants. Never commit credentials, generated binaries or private record evidence.
3. Set `imageSourceType: ai-generated`, `imagePresentation: generated-illustration`, `imageSourceStatus: generated`, the actual dimensions and generation provenance. Set `imageCrop` to null when the generated frame already supplies the intended composition. Keep the original reference separately from `displayImage`.
4. For a redraw based on an owner photo, retain its `sourceFilename` and use the existing original-photo CDN URL as its source-image link when no external source page exists. Do not mislabel a retailer reference as the actual generation input.
5. Compare the before and after payloads. Only selected IDs and image fields should change. Preserve unrelated assets, ordering, facts and presentation. Do not expose purchase or fulfillment states in cards.

## Review and publication

Build the production site and inspect the actual `/library/#cars` page. Decode all gallery images before captures so lazy loading does not create misleading blank cards. Check every affected card on desktop and mobile, both languages and light/dark themes. Let theme transitions finish before capturing. Inspect full images as well as actual card captures; a successful build or screenshot command is not visual review.

Show the finished gallery first. Keep the source receipts, prompts, diffs and captures available without making the owner read a separate report. Once the owner approves that exact batch, record preview approval, run the full release checklist and browser smoke checks, commit explicit paths, push, wait for deployment, and verify the live image URLs and rendered page. Update destination receipts only after live verification.

The accepted October 2026 studio redraws include the 1:64 gallery and the individually approved models in other scales. This does not authorize future replacements of 1:18 images or other accepted assets without a new owner instruction. Background explorations remain candidates until selected.
