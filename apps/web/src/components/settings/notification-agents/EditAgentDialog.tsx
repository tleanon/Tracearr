import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { Settings } from '@tracearr/shared';
import { Loader2 } from 'lucide-react';
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
import type { NotificationAgentType } from './types';
import { validateField } from './types';
import { AGENT_CONFIGS } from './agent-config';

interface EditAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentType: NotificationAgentType;
  settings: Settings | undefined;
}

export function EditAgentDialog({ open, onOpenChange, agentType, settings }: EditAgentDialogProps) {
  const { t } = useTranslation(['notifications', 'pages', 'common']);
  const updateSettings = useUpdateSettings({ silent: true });
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string | null>>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  const config = AGENT_CONFIGS[agentType];

  // Initialize form with current settings values when dialog opens
  useEffect(() => {
    if (open && settings && config) {
      const initialData: Record<string, string> = {};

      config.fields.forEach((field) => {
        const value = settings[field.key as keyof Settings];
        if (value != null) {
          initialData[field.key] = String(value);
        }
      });

      setFormData(initialData);
      setFieldErrors({});
      setTouched({});
    }
  }, [open, settings, config]);

  const handleFieldChange = (key: string, value: string) => {
    setFormData((prev) => ({ ...prev, [key]: value }));

    const field = config.fields.find((f) => f.key === key);
    if (field && touched[key]) {
      setFieldErrors((prev) => ({ ...prev, [key]: validateField(field, value) }));
    }
  };

  const handleFieldBlur = (key: string) => {
    setTouched((prev) => ({ ...prev, [key]: true }));

    // Validate on blur
    const field = config.fields.find((f) => f.key === key);
    if (field) {
      setFieldErrors((prev) => ({ ...prev, [key]: validateField(field, formData[key]) }));
    }
  };

  const validateAllFields = (): boolean => {
    const errors: Record<string, string | null> = {};
    let hasErrors = false;

    config.fields.forEach((field) => {
      const error = validateField(field, formData[field.key]);
      errors[field.key] = error;
      if (error) hasErrors = true;
    });

    setFieldErrors(errors);
    const allTouched: Record<string, boolean> = {};
    config.fields.forEach((field) => {
      allTouched[field.key] = true;
    });
    setTouched(allTouched);

    return !hasErrors;
  };

  const canSave = () => {
    const requiredFilled = config.fields
      .filter((f) => f.required)
      .every((f) => formData[f.key]?.trim());
    const noErrors = !Object.values(fieldErrors).some((e) => e !== null);
    return requiredFilled && noErrors;
  };

  const handleSave = async () => {
    // Validate all fields before saving
    if (!validateAllFields()) {
      return;
    }

    // Build settings update
    const update: Record<string, string | null> = {};

    // Set the fields
    config.fields.forEach((field) => {
      const value = formData[field.key]?.trim();
      update[field.key] = value || null;
    });

    try {
      await updateSettings.mutateAsync(update);
      toast.success(t('toast.success.agentUpdated.title'), {
        description: t('toast.success.agentUpdated.message'),
      });
      onOpenChange(false);
    } catch {
      toast.error(t('toast.error.agentUpdateFailed'));
    }
  };

  const Icon = config.icon;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <div className="h-6 w-6 overflow-hidden rounded">
              {config.imagePath ? (
                <img
                  src={config.imagePath}
                  alt={config.name}
                  className="h-full w-full object-cover"
                />
              ) : (
                <Icon className="h-5 w-5" />
              )}
            </div>
            {t('common:actions.edit')} {config.name}
          </DialogTitle>
          <DialogDescription>{t('pages:settings.notifications.editAgentDesc')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          {config.fields.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {t('pages:settings.notifications.noConfigNeeded')}
            </p>
          ) : (
            config.fields.map((field) => {
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

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common:actions.cancel')}
          </Button>
          <Button onClick={handleSave} disabled={!canSave() || updateSettings.isPending}>
            {updateSettings.isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t('common:states.saving')}
              </>
            ) : (
              t('common:actions.save')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
