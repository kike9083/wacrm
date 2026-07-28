"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  arrayMove,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { databases, account } from "@/lib/appwrite/client";
import { DATABASE_ID, COLLECTIONS } from "@/lib/appwrite/db";
import { Query } from "appwrite";
import type { Pipeline, PipelineStage } from "@/types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Trash2,
  Plus,
  GripVertical,
  AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";

const STAGE_COLORS = [
  "#3b82f6",
  "#6366f1",
  "#8b5cf6",
  "#ec4899",
  "#f43f5e",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#14b8a6",
  "#06b6d4",
];

interface PipelineSettingsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pipeline: Pipeline;
  stages: PipelineStage[];
  onPipelinesChanged: () => void;
  onStagesChanged: () => void;
  onCreateNewPipeline: () => void;
}

export function PipelineSettings({
  open,
  onOpenChange,
  pipeline,
  stages,
  onPipelinesChanged,
  onStagesChanged,
  onCreateNewPipeline,
}: PipelineSettingsProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(pipeline.name);
  const [localStages, setLocalStages] = useState<PipelineStage[]>(stages);
  const [newStageName, setNewStageName] = useState("");
  const [newStageColor, setNewStageColor] = useState(STAGE_COLORS[0]);
  const [saving, setSaving] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Reset form state when the dialog opens or its prop inputs change
  // — legitimate prop-driven sync.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open) return;
    setName(pipeline.name);
    setLocalStages([...stages].sort((a, b) => a.position - b.position));
    setShowDeleteConfirm(false);
  }, [open, pipeline, stages]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  function handleReorder(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = localStages.findIndex((s) => s.id === active.id);
    const newIndex = localStages.findIndex((s) => s.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    setLocalStages(arrayMove(localStages, oldIndex, newIndex));
  }

  async function handleSave() {
    setSaving(true);

    // One upsert for all stages — batches N stage writes into a single
    // round-trip. Previous implementation did N sequential UPDATEs which
    // latency-scaled linearly with stage count.
    const stageRows = localStages.map((s, i) => ({
      id: s.id,
      pipeline_id: s.pipeline_id,
      name: s.name,
      color: s.color,
      position: i,
    }));

    try {
      await Promise.all([
        databases.updateDocument(DATABASE_ID, COLLECTIONS.pipelines, pipeline.id, {
          name: name.trim(),
        }),
        ...stageRows.map((s) =>
          databases.updateDocument(DATABASE_ID, COLLECTIONS.pipelineStages, s.id, {
            name: s.name,
            color: s.color,
            position: s.position,
          })
        ),
      ]);
    } catch {
      toast.error(t('pipelines.failedToSave'));
      setSaving(false);
      return;
    }

    setSaving(false);

    onOpenChange(false);
    onPipelinesChanged();
    onStagesChanged();
    toast.success(t('pipelines.saved'));
  }

  async function handleAddStage() {
    const trimmed = newStageName.trim();
    if (!trimmed) return;
    let data;
    try {
      data = await databases.createDocument(
        DATABASE_ID,
        COLLECTIONS.pipelineStages,
        "unique()",
        {
          pipeline_id: pipeline.id,
          name: trimmed,
          color: newStageColor,
          position: localStages.length,
        }
      );
    } catch {
      toast.error(t('pipelines.failedToAddStage'));
      return;
    }
    setLocalStages([...localStages, { ...data, id: data.$id } as unknown as PipelineStage]);
    setNewStageName("");
    setNewStageColor(STAGE_COLORS[(localStages.length + 1) % STAGE_COLORS.length]);
  }

  async function handleRemoveStage(stageId: string) {
    // Refuse to delete if deals still reference the stage (FK would fail).
    try {
      const { total } = await databases.listDocuments(
        DATABASE_ID,
        COLLECTIONS.deals,
        [Query.equal("stage_id", stageId), Query.limit(0)]
      );
      if (total > 0) {
        toast.error(t('pipelines.moveOrDeleteDealsFirst'));
        return;
      }
    } catch {
      // no deals reference this stage
    }
    try {
      await databases.deleteDocument(DATABASE_ID, COLLECTIONS.pipelineStages, stageId);
    } catch {
      toast.error(t('pipelines.failedToDeleteStage'));
      return;
    }
    setLocalStages(localStages.filter((s) => s.id !== stageId));
  }

  async function handleDeletePipeline() {
    setDeleting(true);
    try {
      await databases.deleteDocument(DATABASE_ID, COLLECTIONS.pipelines, pipeline.id);
    } catch {
      setDeleting(false);
      toast.error(t('pipelines.failedToDelete'));
      return;
    }
    setDeleting(false);
    onOpenChange(false);
    onPipelinesChanged();
    toast.success(t('pipelines.deleted'));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md bg-slate-900 border-slate-700 max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-white">{t('pipelines.managePipeline')}</DialogTitle>
        </DialogHeader>

        {showDeleteConfirm ? (
          <div className="py-4">
            <div className="flex items-center gap-3 rounded-lg border border-red-500/30 bg-red-500/10 p-4">
              <AlertTriangle className="h-5 w-5 shrink-0 text-red-400" />
              <div>
                <p className="text-sm font-medium text-red-400">
                  {t('pipelines.deletePipeline')}
                </p>
                <p className="mt-1 text-xs text-slate-400">
                  {t('pipelines.deleteWarning')}
                </p>
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => setShowDeleteConfirm(false)}
                className="border-slate-700 bg-transparent text-slate-300 hover:bg-slate-800"
              >
                {t('common.cancel')}
              </Button>
              <Button
                onClick={handleDeletePipeline}
                disabled={deleting}
                className="bg-red-600 text-white hover:bg-red-700"
              >
                {deleting ? t('pipelines.deleting') : t('pipelines.deletePipeline')}
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="grid gap-4 py-2">
              <div className="grid gap-2">
                <Label className="text-slate-300">{t('pipelines.pipelineName')}</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="border-slate-700 bg-slate-800 text-white"
                />
              </div>

              <div className="grid gap-2">
                <Label className="text-slate-300">{t('pipelines.stages')}</Label>
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleReorder}
                >
                  <SortableContext
                    items={localStages.map((s) => s.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    <div className="space-y-2">
                      {localStages.map((stage, index) => (
                        <SortableStageRow
                          key={stage.id}
                          stage={stage}
                          onNameChange={(v) => {
                            const updated = [...localStages];
                            updated[index] = { ...updated[index], name: v };
                            setLocalStages(updated);
                          }}
                          onColorChange={(v) => {
                            const updated = [...localStages];
                            updated[index] = { ...updated[index], color: v };
                            setLocalStages(updated);
                          }}
                          onRemove={() => handleRemoveStage(stage.id)}
                          colors={STAGE_COLORS}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>

                {/* Add new stage */}
                <div className="mt-1 flex flex-wrap gap-1">
                  {STAGE_COLORS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      onClick={() => setNewStageColor(color)}
                      className="h-5 w-5 rounded-full border-2 transition-transform hover:scale-110"
                      style={{
                        backgroundColor: color,
                        borderColor:
                          newStageColor === color ? "white" : "transparent",
                      }}
                      aria-label={`Pick color ${color}`}
                    />
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    value={newStageName}
                    onChange={(e) => setNewStageName(e.target.value)}
                    placeholder={t('pipelines.newStageName')}
                    className="border-slate-700 bg-slate-800 text-sm text-white"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleAddStage();
                    }}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleAddStage}
                    disabled={!newStageName.trim()}
                    className="shrink-0 border-slate-700 bg-transparent text-slate-300 hover:bg-slate-800"
                  >
                    <Plus className="mr-1 h-3 w-3" />
                    {t('common.add')}
                  </Button>
                </div>
              </div>

              <Button
                variant="outline"
                onClick={onCreateNewPipeline}
                className="w-full border-slate-700 bg-transparent text-slate-300 hover:bg-slate-800"
              >
                <Plus className="mr-1 h-3 w-3" />
                {t('pipelines.createNew')}
              </Button>
            </div>

            <DialogFooter className="border-slate-700 bg-slate-900/50">
              <Button
                variant="destructive"
                onClick={() => setShowDeleteConfirm(true)}
                className="mr-auto bg-red-600 hover:bg-red-700"
              >
                {t('pipelines.deletePipeline')}
              </Button>
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                className="border-slate-700 bg-transparent text-slate-300 hover:bg-slate-800"
              >
                {t('common.cancel')}
              </Button>
              <Button
                onClick={handleSave}
                disabled={saving || !name.trim()}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {saving ? t('pipelines.saving') : t('pipelines.saveChanges')}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SortableStageRow({
  stage,
  onNameChange,
  onColorChange,
  onRemove,
  colors,
}: {
  stage: PipelineStage;
  onNameChange: (v: string) => void;
  onColorChange: (v: string) => void;
  onRemove: () => void;
  colors: string[];
}) {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: stage.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 p-2"
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        className="cursor-grab touch-none text-slate-500 hover:text-slate-300 active:cursor-grabbing"
        aria-label={t('pipelines.dragToReorder')}
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <ColorSwatch value={stage.color} onChange={onColorChange} colors={colors} />
      <Input
        value={stage.name}
        onChange={(e) => onNameChange(e.target.value)}
        className="h-7 flex-1 border-transparent bg-transparent text-sm text-white focus:border-slate-600"
      />
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={onRemove}
        className="text-slate-400 hover:text-red-400"
      >
        <Trash2 className="h-3 w-3" />
      </Button>
    </div>
  );
}

function ColorSwatch({
  value,
  onChange,
  colors,
}: {
  value: string;
  onChange: (v: string) => void;
  colors: string[];
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="h-4 w-4 rounded-full border border-slate-600"
        style={{ backgroundColor: value }}
        aria-label={t('pipelines.changeColor')}
      />
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-6 z-20 flex flex-wrap gap-1 rounded-lg border border-slate-700 bg-slate-900 p-2 shadow-lg w-36">
            {colors.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => {
                  onChange(c);
                  setOpen(false);
                }}
                className="h-5 w-5 rounded-full border-2 transition-transform hover:scale-110"
                style={{
                  backgroundColor: c,
                  borderColor: c === value ? "white" : "transparent",
                }}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
