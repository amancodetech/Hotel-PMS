import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  TextField,
  Typography,
} from '@mui/material';
import { formatInstant, formatMoney, zones } from '@hotel/i18n';
import type { Preferences } from '@hotel/i18n';

export default function PreferencesPage({
  value,
  update,
}: {
  value: Preferences;
  update: (value: Preferences) => void;
}) {
  const { t } = useTranslation();
  const [amount, setAmount] = useState('1250000.50');
  const [instant] = useState(() => new Date().toISOString());
  let preview = '';
  let invalid = false;
  try {
    preview = formatMoney(amount, value.currency, value.language);
  } catch {
    invalid = true;
  }
  return (
    <div className="preferences-layout">
      <section
        className="preference-fields"
        aria-labelledby="preferences-title"
      >
        <Typography id="preferences-title" variant="h2" component="h2">
          {t('preferences')}
        </Typography>
        <FormControl fullWidth>
          <InputLabel id="language-label">{t('language')}</InputLabel>
          <Select
            labelId="language-label"
            id="language"
            value={value.language}
            label={t('language')}
            onChange={(event) =>
              update({
                ...value,
                language: event.target.value as Preferences['language'],
              })
            }
          >
            <MenuItem value="id-ID" lang="id">
              Bahasa Indonesia
            </MenuItem>
            <MenuItem value="en-US" lang="en">
              English
            </MenuItem>
            <MenuItem value="ar" lang="ar">
              العربية
            </MenuItem>
          </Select>
        </FormControl>
        <FormControl fullWidth>
          <InputLabel id="currency-label">{t('currency')}</InputLabel>
          <Select
            labelId="currency-label"
            id="currency"
            label={t('currency')}
            value={value.currency}
            onChange={(event) =>
              update({
                ...value,
                currency: event.target.value as Preferences['currency'],
              })
            }
          >
            <MenuItem value="IDR">IDR</MenuItem>
            <MenuItem value="USD">USD</MenuItem>
          </Select>
        </FormControl>
        <FormControl fullWidth>
          <InputLabel id="timezone-label">{t('timezone')}</InputLabel>
          <Select
            labelId="timezone-label"
            id="timezone"
            label={t('timezone')}
            value={value.timezone}
            onChange={(event) =>
              update({
                ...value,
                timezone: event.target.value as Preferences['timezone'],
              })
            }
          >
            {zones.map((zone) => (
              <MenuItem key={zone} value={zone}>
                {zone}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </section>
      <section className="format-preview" aria-labelledby="preview-title">
        <Typography id="preview-title" variant="h2" component="h2">
          {t('preview')}
        </Typography>
        <TextField
          label={t('amount')}
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          error={invalid}
          helperText={invalid ? t('invalidAmount') : ' '}
          slotProps={{
            htmlInput: { inputMode: 'decimal', maxLength: 21, dir: 'ltr' },
          }}
          fullWidth
        />
        <output className="money-preview" aria-live="polite">
          {invalid ? '-' : preview}
        </output>
        <dl>
          <dt>{t('date')}</dt>
          <dd>{formatInstant(instant, value.timezone, value.language)}</dd>
        </dl>
      </section>
    </div>
  );
}
