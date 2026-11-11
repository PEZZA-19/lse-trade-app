-- Business logo, shown on quotes, invoices and credit notes. Stored as a small data URL (PNG or
-- JPEG, resized on the device before upload) so documents render without another storage service.
ALTER TABLE tenants ADD COLUMN logo_data_url text
  CHECK (logo_data_url IS NULL OR (length(logo_data_url) <= 400000
         AND logo_data_url ~ '^data:image/(png|jpeg);base64,[A-Za-z0-9+/=]+$'));
