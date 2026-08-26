# public/

Files to share. Anything committed here is served by Netlify at

    https://motionstillcut.netlify.app/public/<filename>

Good for prompts, `.mscut.json` projects, images and short clips. Keep it to
files that belong in git — large videos do not.

`index.html` is the listing; regenerate it after adding or removing files:

    npm run public:index
