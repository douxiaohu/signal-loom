import { Clock } from "../../vendor/delineate/hand/clock";
import { Crew } from "../../vendor/delineate/hand/crew";
import { Hand } from "../../vendor/delineate/hand/hand";
import { Marks } from "../../vendor/delineate/hand/marks";
import { stage } from "../../vendor/delineate/hand/space";

export { mountMessageAssembly } from "./message-assembly";

export function mountAssembly(root: HTMLElement, onFinish: () => void) {
  const clock = new Clock();
  const marks = new Marks(root.querySelector(".marks")!, { rulers: false });
  const layer = root.querySelector<HTMLElement>(".hands")!;
  const names = ["grid", "type", "ink", "copy", "line", "edit"];
  const hands = names.slice(0, root.clientWidth < 600 ? 3 : 6).map((name, i) => new Hand(clock, layer, {
    name: `${name}-0${i + 1}`, colour: `var(--c-${["blue", "rust", "green", "violet", "ochre", "pink"][i]})`, seed: 4101 + i * 17,
    start: { x: root.clientWidth * (0.1 + i * 0.12), y: 32 }, style: { tempo: 0.48, curl: 0.05, scatter: 1 }
  }));
  const crew = new Crew(root.querySelector(".intro-copy")!, hands, marks, clock, stage(root));
  let visible = true;
  let disposed = false;
  const rest = () => !visible || document.hidden ? clock.sleep() : clock.wake();
  const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; rest(); });
  observer.observe(root);
  document.addEventListener("visibilitychange", rest);
  clock.each(() => marks.draw());
  crew.start();
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    crew.stop();
    clock.sleep();
    observer.disconnect();
    document.removeEventListener("visibilitychange", rest);
    layer.replaceChildren();
    root.querySelector(".marks")?.replaceChildren();
  };
  void crew.finished.then(() => { if (!disposed) { dispose(); onFinish(); } });
  return dispose;
}
