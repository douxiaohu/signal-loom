# delineate integration

The Assembly hand engine and the generated botanical / Alfama illustrations are
adapted from [appautomaton/delineate](https://github.com/appautomaton/delineate),
downloaded on 2026-11-17 under the [MIT license](./LICENSE).

- `hand/`: upstream `assembly/hand/` TypeScript engine. The local change gives
  `Crew` ownership of its IntersectionObserver and disconnects it on stop/completion.
- `../../styles/editorial/assembly.css`: upstream hand styles, scoped to
  `.editorial-intro`, with namespaced keyframes.
- `../../../public/artwork/lavender.svg`: upstream Mediterranean plant generator's
  lavender drawing, retaining its original growth metadata.
- `../../../public/artwork/olive.svg`: the olive close study from the same generator.
- `../../../public/artwork/alfama.html`: Alfama `gen.ts` placeholders applied to
  `art.html`, using upstream `unfoldLife` and `pruneDefs`.
- `../../styles/editorial/alfama.css` and `botanical.css`: upstream scene and paint
  styles adapted to the React host's light state and scoped plant containers.

The React integration lives in `components/editorial/`. It owns request cancellation,
offscreen/hidden-tab suspension, reduced motion, the day/night switch and footer
navigation. The engine only mutates the static intro sheet; it never owns the live
feed or form controls. Live message assembly reuses Hand/Marks/Clock with read-only
Range measurements and visual glyph masks, retaining React's complete text and media
nodes. Interaction immediately settles an unfinished card. All illustrations are
served locally without a remote runtime.

The corresponding upstream guidance is
[Assembly](https://github.com/appautomaton/delineate/tree/main/.agents/skills/assembly),
[Climate Garden](https://github.com/appautomaton/delineate/tree/main/.agents/skills/climate-garden)
and [Footers](https://github.com/appautomaton/delineate/blob/main/footers/notes.md).
The public artwork directory also carries the upstream license.
