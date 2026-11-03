# Model-car criteria

Completion criteria for the model-car gallery at `/library/cars/`. They apply together with the general [completion criteria](completion-criteria.md). For the order of work when adding a car, follow [model-car intake](model-car-intake.md). For AI redraws (new 1:64 cars, and other cars only when explicitly authorized) and background variants, also follow [model-car redraws](model-car-redraws.md).

## Identity and source

- Account for every supplied model. Verify manufacturer, SKU, scale, color, livery/number, edition, and included accessories. Similar models from different manufacturers remain distinct records. Preserve established scale order: **1:18, 1:64, 1:43, 1:32**, including the accepted Takara Tomy placement in 1:64.
- **Hard requirement: check the manufacturer's official website and full product gallery first, before selecting any new or replacement image or AI-generation reference.** Open the exact product page and inspect the actual photographs, including gallery views beyond the lead image. Retain the official page and image URLs, the views inspected, and the reason for the selected reference. A search-result snippet or a retailer carrying the brand does not count as this check.
- Only then consider authorized distributors, followed by retailers/collectors. A fallback reference requires a recorded explanation of why the official material cannot supply the exact edition, required view or usable detail. A failed HTTPS request, blocked browser, regional storefront search, filename, or manufacturer logo does not establish source absence or authenticity. Try the actual supplied URL and plausible transport/browser alternative before declaring a source unavailable. An unresolved official-source check remains unfinished; do not generate from a convenient fallback and treat good-looking output as satisfying the gate.
- Review all owner-supplied candidates before replacing or rejecting them. Preserve the owner's selected open-panel and accessory views; a cleaner closed-car photograph is not an equivalent substitute.
- Keep the product-page URL, exact source-image URL, displayed CDN URL, native dimensions, source category, treatment, and any identity/source uncertainty in the record or source receipt. Distinguish manufacturer originals from retailer-hosted material. Retain findings so failed searches are not restarted without a new lead.

## The finished card

- Show the established **photo, manufacturer, scale, and title**. Do not add purchase/fulfillment labels or badges such as Ordered, Deposit paid, collected, delivered, or wishlist, including Chinese equivalents. Keep private notes and source-audit prose out of public cards unless requested. Private data fields do not authorize new public UI.
- New or replaced photographs should show a single selected **three-quarter view, roughly 45 degrees**, consistent with accepted neighboring cards. A head-on view, packaging-dominated image, or multi-view product sheet does not satisfy that requirement merely because it is official. An actual product set and an explicitly accepted composition remain exceptions, not reasons to change other approved cards.
- Use uniform **3:2 frames** while preserving original proportions and the accepted rounded card treatment. All scales share the same card size (the owner dropped the larger 1:18 card requirement on 2026-11-01); match apparent subject scale and balance within each scale. Keep the complete car, open parts, included accessories/base, and natural shadow visible; reject avoidable clipping and empty space that makes the subject tiny. Do not stretch, upscale a weak source to disguise poor quality, or invent missing detail. The card's background treatment does not authorize repainting the photograph's original background.
- Preserve original subject pixels, color, lighting, background, and natural shadows. Prefer a conservative rectangular crop. No AI redraw, silhouette masking, invented shadows, or generic background repainting without an explicit treatment decision. Permission to clean one image does not authorize the same treatment for the collection. Exception: new 1:64 additions get the studio redraw by default (owner decision, 2026-11-02); follow [model-car redraws](model-car-redraws.md).
- Inspect each affected original and final image at useful detail, then in its card. Check focus, whole-subject framing, shadow edges, all four corners, background seams, stray text, logos, and neighboring-card consistency. After fixes, review the whole affected set again. A contact sheet supplements this inspection; it does not replace it.
- After adding or replacing a car image, run `npm run library:car-variants` and then `npm run library:car-variants -- --verify`. The cars page serves those 480/800 px WebP variants; see [images](images.md#model-car-variants).
- Purchase and fulfillment status is private. It lives only in the owner's Life Records, never in `src/data/library/model-cars.json`.
- Clicking a car image navigates to its related ownership post when one exists. Otherwise it does nothing. Do not add a lightbox, hover enlargement, or unrelated destination without a new request.

## Accepted choices to carry forward

These were settled during the October 10 collection review. Preserve them unless a later direction explicitly changes them; do not reopen the whole gallery while adding a few cars.

| Record | Accepted choice |
| --- | --- |
| Exoto RLG19091 | Official front/left three-quarter source, final option 3387/A. |
| CMC M-284 | Roof-on official prototype photo, superseding the earlier roof-off request. |
| CMC M-109 | Accepted existing image. |
| AUTOart 80643 | Lower front three-quarter view, option A. |
| AUTOart 88646 | Original studio photograph, option A. |
| FG GT40 / FG RWB 930 | Keep the accepted open-panel owner photographs: `fg-gt40-black` from `IMG_1387.jpeg`, `fg-rwb930-pink` from `IMG_1389.jpeg`. |
| MINI GT 911 Dakar / Roughroads | Original composition and MINI GT logos explicitly accepted. Do not remove the logos or silently replace the accepted set composition. |
| Minichamps Carrera Cup 1993 #33 | `MINICHAMPS-911-33`, SKU `430936033`: the original search had an accepted clean-source limitation, distinct from the verified #91 model. The October 16 scoped redraw approval below supersedes the old displayed photo. |

Use `src/data/library/model-cars.json` and retained review evidence to resolve the exact accepted asset. Do not infer a new image choice from this table alone. The accepted INNO RWB Porsche 930 #89 card is a useful reference for the current additions' single-view presentation, not a mandate to replace other approved photographs.

On October 16, the owner explicitly requested and then approved generated redraws for the three marked existing cards: `MINICHAMPS-911-33`, `BBURAGO-FOCUS-2008`, and `BBURAGO-C4-2009`. Preserve those accepted assets and their generated provenance. This is a scoped exception to the original-photograph default, not permission to redraw other cars. The three new additions (LCD Pagani, Kaido House AE86, and INNO 930) are separate records; do not confuse the two sets of three.

Later that evening, the owner separately approved redraws for `local-lcd-huayra-r-matte-white-1-43` and `huayra-bc-event`. Preserve those two approved assets too, including the purple Huayra BC's open doors. These additional exceptions do not change the treatment of the INNO Porsche or the rest of the collection.
