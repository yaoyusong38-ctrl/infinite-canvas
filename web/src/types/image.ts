export type ReferenceImage = {
    id: string;
    name: string;
    type: string;
    dataUrl: string;
    url?: string;
    storageKey?: string;
};

export type QwenImageTask = {
    id: string;
    baseUrl: string;
    state: "submitting" | "queued" | "running" | "timeout" | "waiting";
};
