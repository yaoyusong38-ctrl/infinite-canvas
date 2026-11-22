import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import localforage from "localforage";
import { nanoid } from "nanoid";
import i18n from "@/i18n";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { CanvasAssistantSession, CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";

export type CanvasProject = {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    viewport: ViewportTransform;
};

export type CanvasDeletedProject = {
    id: string;
    deletedAt: string;
};

type CanvasStore = {
    hydrated: boolean;
    projects: CanvasProject[];
    deletedProjects: CanvasDeletedProject[];
    createProject: (title?: string) => string;
    importProject: (project: Partial<CanvasProject>) => string;
    openProject: (id: string) => CanvasProject | null;
    renameProject: (id: string, title: string) => void;
    deleteProjects: (ids: string[]) => void;
    replaceProjects: (projects: CanvasProject[], deletedProjects?: CanvasDeletedProject[]) => void;
    updateProject: (id: string, patch: Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo" | "viewport">>) => void;
};

const initialViewport: ViewportTransform = { x: 0, y: 0, k: 1 };
const CANVAS_STORE_KEY = "infinite-canvas:canvas_store";
const canvasDisk = localforage.createInstance({ name: "infinite-canvas", storeName: "app_state", driver: localforage.INDEXEDDB });
type PersistedCanvasState = Pick<CanvasStore, "projects" | "deletedProjects">;
type CanvasSaveStatus = "saved" | "saving" | "error";
export const useCanvasSaveStatus = create<CanvasSaveStatus>(() => "saved");
let queuedPersistState: PersistedCanvasState | null = null;
let pendingWrite: (() => Promise<void>) | null = null;
let writing: Promise<void> | null = null;

function warnUnsaved(event: BeforeUnloadEvent) {
    event.preventDefault();
    event.returnValue = true;
}

if (typeof window !== "undefined") {
    useCanvasSaveStatus.subscribe((status) => {
        if (status === "saved" || (!pendingWrite && !writing)) window.removeEventListener("beforeunload", warnUnsaved);
        else window.addEventListener("beforeunload", warnUnsaved);
    });
}

export function flushCanvasStorage() {
    if (writing) return writing;
    if (!pendingWrite) return Promise.resolve();
    useCanvasSaveStatus.setState("saving", true);
    writing = Promise.resolve().then(async () => {
        try {
            while (pendingWrite) {
                const write = pendingWrite;
                pendingWrite = null;
                try {
                    await write();
                } catch (error) {
                    // A newer snapshot, if queued, already contains these edits.
                    pendingWrite ??= write;
                    throw error;
                }
            }
            useCanvasSaveStatus.setState("saved", true);
        } catch (error) {
            useCanvasSaveStatus.setState("error", true);
            throw error;
        } finally {
            writing = null;
        }
    });
    return writing;
}

const canvasStorage: PersistStorage<CanvasStore> = {
    getItem: async (name) => {
        const value = await canvasDisk.getItem<string>(name);
        if (!value) return null;
        const parsed = JSON.parse(value) as StorageValue<CanvasStore>;
        queuedPersistState = parsed.state as PersistedCanvasState;
        return parsed;
    },
    setItem: (name, value) => {
        const nextState = value.state as PersistedCanvasState;
        if (queuedPersistState && queuedPersistState.projects === nextState.projects && queuedPersistState.deletedProjects === nextState.deletedProjects) return;
        queuedPersistState = nextState;
        pendingWrite = async () => { await canvasDisk.setItem(name, JSON.stringify(value)); };
        void flushCanvasStorage().catch(() => undefined);
    },
    removeItem: (name) => canvasDisk.removeItem(name),
};

export const useCanvasStore = create<CanvasStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            projects: [],
            deletedProjects: [],
            createProject: (title = i18n.t("canvas.project.untitled")) => {
                const now = new Date().toISOString();
                const id = nanoid();
                const project: CanvasProject = {
                    id,
                    title,
                    createdAt: now,
                    updatedAt: now,
                    nodes: [],
                    connections: [],
                    chatSessions: [],
                    activeChatId: null,
                    backgroundMode: "lines",
                    showImageInfo: false,
                    viewport: initialViewport,
                };
                set((state) => ({ projects: [project, ...state.projects] }));
                return id;
            },
            importProject: (source) => {
                const now = new Date().toISOString();
                const project: CanvasProject = {
                    id: nanoid(),
                    title: source.title || i18n.t("canvas.project.imported"),
                    createdAt: source.createdAt || now,
                    updatedAt: now,
                    nodes: source.nodes || [],
                    connections: source.connections || [],
                    chatSessions: source.chatSessions || [],
                    activeChatId: source.activeChatId || null,
                    backgroundMode: source.backgroundMode || "lines",
                    showImageInfo: source.showImageInfo || false,
                    viewport: source.viewport || initialViewport,
                };
                set((state) => ({ projects: [project, ...state.projects] }));
                return project.id;
            },
            openProject: (id) => {
                return get().projects.find((item) => item.id === id) || null;
            },
            renameProject: (id, title) =>
                set((state) => ({
                    projects: state.projects.map((project) => (project.id === id ? { ...project, title: title.trim() || project.title, updatedAt: new Date().toISOString() } : project)),
                })),
            deleteProjects: (ids) =>
                set((state) => {
                    const now = new Date().toISOString();
                    const removing = new Set(ids);
                    const projects = state.projects.filter((project) => !removing.has(project.id));
                    const deletedProjects = [...state.deletedProjects.filter((item) => !removing.has(item.id)), ...ids.map((id) => ({ id, deletedAt: now }))];
                    return { projects, deletedProjects };
                }),
            replaceProjects: (projects, deletedProjects = []) => set({ projects, deletedProjects }),
            updateProject: (id, patch) =>
                set((state) => ({
                    projects: state.projects.map((project) => (project.id === id ? { ...project, ...patch, updatedAt: new Date().toISOString() } : project)),
                })),
        }),
        {
            name: CANVAS_STORE_KEY,
            storage: canvasStorage,
            partialize: (state) =>
                ({
                    projects: state.projects,
                    deletedProjects: state.deletedProjects,
                }) as StorageValue<CanvasStore>["state"],
            onRehydrateStorage: () => (_state, error) => {
                if (error) {
                    useCanvasSaveStatus.setState("error", true);
                    return;
                }
                if (!pendingWrite && !writing) useCanvasSaveStatus.setState("saved", true);
                useCanvasStore.setState({ hydrated: true });
            },
        },
    ),
);
