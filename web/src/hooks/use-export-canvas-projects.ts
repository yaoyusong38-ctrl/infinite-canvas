import { App } from "antd";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import { exportCanvasProjects } from "@/lib/canvas/canvas-export";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

export function useExportCanvasProjects() {
    const { message } = App.useApp();
    const { t } = useTranslation();

    return useCallback(async (projects: CanvasProject[], fileName: string) => {
        const hide = message.loading(t("canvas.projectPage.exporting"), 0);
        try {
            await exportCanvasProjects(projects, fileName);
            message.success(t("canvas.projectPage.exported"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("canvas.sidePanel.exportFailed"));
        } finally {
            hide();
        }
    }, [message, t]);
}
