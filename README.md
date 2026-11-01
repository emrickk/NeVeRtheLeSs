# NeVeRtheLeSs

2005 年至今的个人博客 · personal blog since 2005, bilingual (Chinese and English), served at https://theneverless.com.

## Stack

- [Astro](https://astro.build) 6 with the [astro-tone](https://github.com/hanityx/astro-tone) theme, migrated from an 18-year WordPress archive (migration tooling in `scripts/migrate/`).
- Static build with a Pagefind search index, deployed to GitHub Pages by `.github/workflows/deploy.yml` on push to `main`.
- Post images are served from Cloudflare R2 at `cdn.theneverless.com`, not stored in this repository (see [docs/images.md](docs/images.md)).

```sh
npm ci
npm run dev      # local dev server
npm run build    # production build + Pagefind index
```

## Working on this repository

Start with [AGENTS.md](AGENTS.md): it is the entry point for contributors and AI agents, covering commands, architecture, safety gates and rules. Runbooks and design history live in [docs/](docs/).

## License

Source code: MIT (see [LICENSE](LICENSE); theme © Tone contributors, blog-specific code © NeVeRtheLeSs).
**All blog content (posts under `src/content/posts/`, archived comments under `src/data/comments/`, and media served from `cdn.theneverless.com`) is © NeVeRtheLeSs, all rights reserved.** The MIT license does not apply to the content.
