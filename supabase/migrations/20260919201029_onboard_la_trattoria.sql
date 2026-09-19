insert into public.tenants (
  slug,
  name,
  whatsapp_number,
  branding,
  attribute_schema,
  sale_mode,
  stock_mode,
  fulfilment_mode,
  active
) values (
  'la-trattoria',
  'La Trattoria',
  '27822279048',
  '{"primary":"#008C45","logo_url":null,"tagline":null,"labels":{"catalogue":"Menu","cart":"Order"}}'::jsonb,
  '[]'::jsonb,
  'unit',
  'availability',
  'collect',
  true
);
