# My Astro Site

This site was created with **phantomwp** - migrated from WordPress to Astro.

## Project Structure

```
/
├── docs/
│   ├── ai-instructions.md   # Your preferences & custom APIs for the AI
│   └── notes.md             # AI scratchpad
├── public/
├── src/
│   ├── pages/
│   │   └── index.astro
│   └── utils/
│       └── blog-helpers.ts   # Helper functions for working with blog posts
└── package.json
```

Astro looks for `.astro`, `.md`, or `.mdx` files in the `src/pages/` directory. Each page is exposed as a route based on its file name. MDX files allow you to use React components and access frontmatter fields directly in your content.

## AI Assistant

The `docs/` folder lets you customize the AI:

- **ai-instructions.md** - Your preferences and custom APIs
- **notes.md** - AI scratchpad for notes

## Commands

All commands are run from the root of the project:

| Command                | Action                                           |
| :--------------------- | :----------------------------------------------- |
| `npm install`        | Installs dependencies                            |
| `npm run dev`        | Starts local dev server at `localhost:4321`    |
| `npm run build`      | Build your production site to `./dist/`        |
| `npm run preview`    | Preview your build locally, before deploying     |

## Blog Helper Functions

The `src/utils/blog-helpers.ts` file contains useful code snippets for working with blog posts:

- **Get all posts**: `getAllPosts()`
- **Filter by category/tag**: `getPostsByCategory()`, `getPostsByTag()`
- **Pagination**: `paginatePosts()`
- **Related posts**: `getRelatedPosts()`
- **Search**: `searchPosts()`
- **Archives**: `getPostArchives()`
- And many more!

Check the file for complete documentation and usage examples.

## Documentation

Check out [Astro documentation](https://docs.astro.build) or jump into the [Discord server](https://astro.build/chat).

## Created with phantomwp

Learn more about migrating from WordPress to Astro at [phantomwp.com](https://phantomwp.com)
