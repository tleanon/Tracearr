import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { Settings } from '@tracearr/shared';
import { Loader2, ChevronRight, Lock } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field, FieldLabel, FieldError } from '@/components/ui/field';
import { useUpdateSettings } from '@/hooks/queries/useSettings';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import type { NotificationAgentType } from './types';
import { validateField } from './types';
import type { AddableAgentInfo } from './useActiveAgents';
import { AGENT_CONFIGS } from './agent-config';

interface AgentOptionButtonProps {
  agentInfo: AddableAgentInfo;
  onSelect: () => void;
}

function AgentOptionButton({ agentInfo, onSelect }: AgentOptionButtonProps) {
  const config = AGENT_CONFIGS[agentInfo.type];
  const Icon = config.icon;
  const isDisabled = !agentInfo.isAvailable;

  return (
    <button
      type="button"
      onClick={isDisabled ? undefined : onSelect}
      disabled={isDisabled}
      className={cn(
        'flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors',
        isDisabled ? 'cursor-not-allowed opacity-50' : 'hover:bg-muted hover:border-primary/50'
      )}
    >
      <div
        className={cn(
          'flex h-10 w-10 items-center justify-center overflow-hidden rounded-lg',
          isDisabled ? 'bg-muted/50' : 'bg-muted'
        )}
      >
        {config.imagePath ? (
          <img
            src={config.imagePath}
            alt={config.name}
            className={cn('h-full w-full object-cover', isDisabled && 'grayscale')}
          />
        ) : (
          <Icon className="h-5 w-5" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="font-medium">{config.name}</p>
        <p className="text-muted-foreground text-xs">
          {isDisabled ? agentInfo.unavailableReason : config.description}
        </p>
      </div>
      {isDisabled ? (
        <Lock className="text-muted-foreground h-4 w-4 flex-shrink-0" />
      ) : (
        <ChevronRight className="text-muted-foreground h-4 w-4 flex-shrink-0" />
      )}
    </button>
  );
}

interface AddAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Discord agent info (null if already configured) */
  discord: AddableAgentInfo | null;
  /** Webhook agents with availability info */
  webhookAgents: AddableAgentInfo[];
  /** Currently active webhook agent (for messaging) */
  activeWebhookAgent: NotificationAgentType | null;
  settings: Settings | undefined;
}

export function AddAgentDialog({
  open,
  onOpenChange,
  discord,
  webhookAgents,
  activeWebhookAgent,
  settings,
}: AddAgentDialogProps) {
  const { t } = useTranslation(['notifications', 'pages', 'common']);
  const updateSettings = useUpdateSettings({ silent: true });
  const [selectedType, setSelectedType] = useState<NotificationAgentType | null>(null);
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string | null>>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  // Reset form when dialog opens/closes
  useEffect(() => {
    if (open) {
      setSelectedType(null);
      setFormData({});
      setFieldErrors({});
      setTouched({});
    }
  }, [open]);

  // When type is selected, initialize form with current settings values
  useEffect(() => {
    if (selectedType && settings) {
      const config = AGENT_CONFIGS[selectedType];
      const initialData: Record<string, string> = {};

      config.fields.forEach((field) => {
        const value = settings[field.key as keyof Settings];
        if (value != null) {
          initialData[field.key] = String(value);
        }
      });

      setFormData(initialData);
    }
  }, [selectedType, settings]);

  const selectedConfig = selectedType ? AGENT_CONFIGS[selectedType] : null;

  const handleFieldChange = (key: string, value: string) => {
    setFormData((prev) => ({ ...prev, [key]: value }));

    // Validate on change if the field has been touched
    if (selectedConfig) {
      const field = selectedConfig.fields.find((f) => f.key === key);
      if (field && touched[key]) {
        setFieldErrors((prev) => ({ ...prev, [key]: validateField(field, value) }));
      }
    }
  };

  const handleFieldBlur = (key: string) => {
    setTouched((prev) => ({ ...prev, [key]: true }));

    // Validate on blur
    if (selectedConfig) {
      const field = selectedConfig.fields.find((f) => f.key === key);
      if (field) {
        setFieldErrors((prev) => ({ ...prev, [key]: validateField(field, formData[key]) }));
      }
    }
  };

  const validateAllFields = (): boolean => {
    if (!selectedConfig) return false;

    const errors: Record<string, string | null> = {};
    let hasErrors = false;

    selectedConfig.fields.forEach((field) => {
      const error = validateField(field, formData[field.key]);
      errors[field.key] = error;
      if (error) hasErrors = true;
    });

    setFieldErrors(errors);
    // Mark all fields as touched to show errors
    const allTouched: Record<string, boolean> = {};
    selectedConfig.fields.forEach((field) => {
      allTouched[field.key] = true;
    });
    setTouched(allTouched);

    return !hasErrors;
  };

  const canSave = () => {
    if (!selectedConfig) return false;

    // Check all required fields are filled
    const requiredFilled = selectedConfig.fields
      .filter((f) => f.required)
      .every((f) => formData[f.key]?.trim());

    // Validate all fields (not just those with errors in state)
    const allValid = selectedConfig.fields.every((field) => {
      const error = validateField(field, formData[field.key]);
      return error === null;
    });

    return requiredFilled && allValid;
  };

  const handleSave = async () => {
    if (!selectedConfig) return;

    // Validate all fields before saving
    if (!validateAllFields()) {
      return;
    }

    // Build settings update
    const update: Partial<Settings> = {};

    // Set the fields
    selectedConfig.fields.forEach((field) => {
      const value = formData[field.key]?.trim();
      if (value) {
        (update as Record<string, string>)[field.key] = value;
      }
    });

    // Set webhookFormat for custom webhook agents
    if (selectedConfig.webhookFormat) {
      update.webhookFormat = selectedConfig.webhookFormat;
    }

    try {
      await updateSettings.mutateAsync(update);
      toast.success(t('toast.success.agentAdded.title'), {
        description: t('toast.success.agentAdded.message'),
      });
      onOpenChange(false);
    } catch {
      toast.error(t('toast.error.agentAddFailed'));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('pages:settings.notifications.addAgent')}</DialogTitle>
          <DialogDescription>{t('pages:settings.notifications.addAgentDesc')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          {/* Agent type selector */}
          {!selectedType && (
            <div className="flex flex-col gap-4">
              {/* Discord - standalone */}
              {discord && (
                <AgentOptionButton
                  agentInfo={discord}
                  onSelect={() => setSelectedType(discord.type)}
                />
              )}

              {/* Webhook agents group */}
              {webhookAgents.length > 0 && (
                <div className="space-y-3">
                  <div className="flex items-center gap-3">
                    <div className="bg-border h-px flex-1" />
                    <span className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
                      {t('pages:settings.notifications.webhookAgents')}
                    </span>
                    <div className="bg-border h-px flex-1" />
                  </div>
                  {activeWebhookAgent && (
                    <div className="bg-muted/50 text-muted-foreground flex items-start gap-2 rounded-md border px-3 py-2 text-xs">
                      <Lock className="mt-0.5 h-3 w-3 flex-shrink-0" />
                      <span>
                        {t('pages:settings.notifications.oneWebhookLimit')}{' '}
                        {t('pages:settings.notifications.currentlyConfigured', {
                          name: AGENT_CONFIGS[activeWebhookAgent].name,
                        })}
                      </span>
                    </div>
                  )}
                  <div className="space-y-2">
                    {webhookAgents.map((agentInfo) => (
                      <AgentOptionButton
                        key={agentInfo.type}
                        agentInfo={agentInfo}
                        onSelect={() => setSelectedType(agentInfo.type)}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Empty state */}
              {!discord && webhookAgents.length === 0 && (
                <p className="text-muted-foreground py-4 text-center text-sm">
                  {t('pages:settings.notifications.allAgentsConfigured')}
                </p>
              )}
            </div>
          )}

          {/* Configuration fields */}
          {selectedConfig && (
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-3 border-b pb-3">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelectedType(null)}
                  className="h-8"
                >
                  ← {t('common:actions.back')}
                </Button>
                <div className="flex items-center gap-2">
                  <div className="h-6 w-6 overflow-hidden rounded">
                    {selectedConfig.imagePath ? (
                      <img
                        src={selectedConfig.imagePath}
                        alt={selectedConfig.name}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      (() => {
                        const Icon = selectedConfig.icon;
                        return <Icon className="h-5 w-5" />;
                      })()
                    )}
                  </div>
                  <span className="font-medium">{selectedConfig.name}</span>
                </div>
              </div>

              {selectedConfig.fields.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  {t('pages:settings.notifications.noConfigNeeded')}
                </p>
              ) : (
                selectedConfig.fields.map((field) => {
                  const error = touched[field.key] ? fieldErrors[field.key] : null;
                  return (
                    <Field key={field.key} data-invalid={!!error}>
                      <FieldLabel htmlFor={field.key}>
                        {field.label}
                        {field.required && <span className="text-destructive ml-1">*</span>}
                      </FieldLabel>
                      <Input
                        id={field.key}
                        type={field.type === 'secret' ? 'password' : 'text'}
                        placeholder={field.placeholder}
                        value={formData[field.key] ?? ''}
                        onChange={(e) => handleFieldChange(field.key, e.target.value)}
                        onBlur={() => handleFieldBlur(field.key)}
                        aria-invalid={!!error}
                      />
                      {error && <FieldError>{error}</FieldError>}
                    </Field>
                  );
                })
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common:actions.cancel')}
          </Button>
          {selectedType && (
            <Button onClick={handleSave} disabled={!canSave() || updateSettings.isPending}>
              {updateSettings.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('common:states.saving')}
                </>
              ) : (
                t('pages:settings.notifications.saveAgent')
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
