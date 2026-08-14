-- Alta de pseudo-artículos en sales_excluded_items.
--
-- sales_lines mezcla artículos reales con códigos administrativos del ERP que
-- NO son productos: descuentos por pago, notas de crédito por error de
-- facturación, agregados de ISIS. Si no se excluyen, cada una de esas líneas
-- cuenta como una compra y corre la fecha de "última compra" del cliente:
-- había 178 de 1234 clientes con la fecha distorsionada por esto.
--
-- Ya existían en la tabla: 1101, P5%, P10%, P15%, P20%, P23.5%, P25%,
-- COTIZ-2%, DTOXVOL, DTOSUPER, DEVERRORFC.
--
-- Faltaban dos grupos:
--
-- 1) La familia PAGO-* (1342 líneas, ~94 clientes). Es otra familia distinta
--    de P25% / P15%, con su propio prefijo.
--
-- 2) Las variantes de grafía. La tabla tenía DTOSUPER/DTOXVOL/DEVERRORFC/
--    COTIZ-2% en mayúsculas, pero los datos traen DtoSuper/DtoxVol/DevErrorFC/
--    Cotiz-2%, así que no matcheaban. Se dan de alta con la grafía exacta del
--    ERP en vez de comparar con upper() en las RPCs: aplicar una función a
--    item_code sobre 260k filas rompe el plan (~+700ms por consulta).
--
-- Si aparece una grafía nueva en una importación futura, hay que darla de alta
-- acá. Para detectarlas:
--
--   SELECT sl.item_code, count(*)
--   FROM sales_lines sl
--   LEFT JOIN products p ON p.cod = sl.item_code
--   WHERE p.cod IS NULL
--     AND (sl.item_code LIKE '%!%%' ESCAPE '!'
--          OR sl.item_code ~* '^(pago|dto|cotiz|dev|desc)')
--     AND sl.item_code NOT IN (SELECT item_code FROM sales_excluded_items)
--   GROUP BY sl.item_code;

INSERT INTO sales_excluded_items (item_code, motivo)
SELECT v.code, 'descuento por pago / no es producto'
FROM (VALUES
  ('PAGO-25%'), ('PAGO-20%'), ('PAGO-30%'),
  ('PAGO-15%'), ('PAGO-24%'), ('PAGO-16%')
) AS v(code)
WHERE NOT EXISTS (
  SELECT 1 FROM sales_excluded_items e WHERE upper(e.item_code) = upper(v.code)
);

INSERT INTO sales_excluded_items (item_code, motivo)
SELECT v.code, 'descuento / no es producto (variante de grafía del ERP)'
FROM (VALUES
  ('DtoSuper'), ('DtoxVol'), ('DevErrorFC'), ('Cotiz-2%')
) AS v(code)
WHERE NOT EXISTS (
  SELECT 1 FROM sales_excluded_items e WHERE e.item_code = v.code
);
