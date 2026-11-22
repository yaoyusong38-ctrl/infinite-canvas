import { afterAll, describe, expect, it } from "bun:test";
import type { CanvasNodeData } from "@/types/canvas";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
if (!originalStorage) {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null } });
    afterAll(() => { Reflect.deleteProperty(globalThis, "localStorage"); });
}
const { buildNodeGenerationContext } = await import("@/components/canvas/canvas-node-generation");
const { directorNodeDefinition } = await import("@/components/canvas/nodes/director-node");
const { registerNodeDefinitions } = await import("@/lib/canvas/node-registry");

describe("Director node resource contract", () => {
    it("exposes the preview image or previs video as the node resource metadata", () => {
        const image = { directorThumbnailStorageKey: "image:shot", storageKey: "image:shot" };
        const video = { directorVideoContent: "blob:preview", directorVideoStorageKey: "director-video:preview" };
        expect(image.directorThumbnailStorageKey.startsWith("image:")).toBe(true);
        expect(video.directorVideoStorageKey.startsWith("director-video:")).toBe(true);
    });

    it("passes the stored video key to generation even when the node also has a thumbnail", () => {
        registerNodeDefinitions([directorNodeDefinition], "kunpeng-director");
        const director: CanvasNodeData = {
            id: "director",
            type: directorNodeDefinition.type,
            title: "导演台",
            position: { x: 0, y: 0 },
            width: 360,
            height: 250,
            metadata: { storageKey: "image:shot", directorThumbnailStorageKey: "image:shot", directorVideoStorageKey: "director-video:preview", directorVideoMimeType: "video/mp4" },
        };
        const edges = [{ id: "reference", fromNodeId: director.id, toNodeId: "config" }];
        const context = buildNodeGenerationContext("config", [director], edges, "");
        expect(context.referenceImages).toHaveLength(0);
        expect(context.referenceVideos).toEqual([{ id: "director", name: "导演台.mp4", type: "video/mp4", url: "", storageKey: "director-video:preview" }]);

        director.metadata = { directorThumbnailStorageKey: "image:shot" };
        const still = buildNodeGenerationContext("config", [director], edges, "");
        expect(still.referenceImages[0]?.storageKey).toBe("image:shot");
        expect(still.referenceVideos).toHaveLength(0);
    });
});
