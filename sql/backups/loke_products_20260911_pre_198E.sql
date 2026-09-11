-- Backup de public.loke_products (proyecto LK) ANTES del alta del 198E — 2026-09-11.
-- Protocolo del CLAUDE.md: backup antes de tocar datos. Son las 23 filas que habia.
-- Restore: correr este archivo. Para deshacer SOLO el alta:
--   delete from public.loke_products where cod = '198E';
insert into public.loke_products (id, cod, description, category, list_price, uxb, active, equiv_product_id) values ('0a5a4594-8074-4a9a-9ffa-328718ca2c78'::uuid, '101', 'Abrelatas A Manija', 'Abrelatas', 2865, 6, true, 'ed4b3029-22ca-4c8e-9c28-f5f812e5c08d'::uuid) on conflict (id) do nothing;
insert into public.loke_products (id, cod, description, category, list_price, uxb, active, equiv_product_id) values ('69965f46-a760-4af6-a9df-3e05ee58b2d1'::uuid, '102E', 'Abrelatas Mariposa', 'Abrelatas', 1100, 12, true, '12a65558-bcd4-4cf5-b7d3-5f86a705e039'::uuid) on conflict (id) do nothing;
insert into public.loke_products (id, cod, description, category, list_price, uxb, active, equiv_product_id) values ('6ae5649d-a4de-4eb1-bcb4-2b9872793bd4'::uuid, '103', 'Abrelatas Uña Cromado', 'Abrelatas', 465, 12, true, '8f887e4c-e10b-4abc-b9f2-99970c026b7c'::uuid) on conflict (id) do nothing;
insert into public.loke_products (id, cod, description, category, list_price, uxb, active, equiv_product_id) values ('b0dbd647-0706-4e35-9ba9-4a2919715595'::uuid, '104', 'Sacacorchos Mgo Ergonómico Nylon', 'Sacacorchos', 820, 12, true, 'ef78cf96-3283-45ea-b3d8-04553d5b18c4'::uuid) on conflict (id) do nothing;
insert into public.loke_products (id, cod, description, category, list_price, uxb, active, equiv_product_id) values ('e7bab5e1-8b9d-493a-94fc-6fda8fcff3de'::uuid, '106E', 'Sacacorchos Doble Impulso Inox.', 'Sacacorchos', 1310, 12, true, '5d638cfc-fa16-4d32-8285-74c6f76e10cb'::uuid) on conflict (id) do nothing;
insert into public.loke_products (id, cod, description, category, list_price, uxb, active, equiv_product_id) values ('6da5e7ec-916c-44d9-9a71-df283007ec78'::uuid, '107', 'Pelador Cuchilla Laser', 'Peladores', 0, 12, true, 'c6b4a83c-4f49-4340-bc4c-efc6c32a0c41'::uuid) on conflict (id) do nothing;
insert into public.loke_products (id, cod, description, category, list_price, uxb, active, equiv_product_id) values ('eef9cfe2-bb2c-4272-b30e-2fa8c1304ca3'::uuid, '108', 'Pelapapas Mango Metálico', 'Peladores', 1095, 12, true, 'e2a94140-98bb-426b-beef-2c2662fa9b22'::uuid) on conflict (id) do nothing;
insert into public.loke_products (id, cod, description, category, list_price, uxb, active, equiv_product_id) values ('d4a10072-c222-4b95-9351-5d0694bfe8ed'::uuid, '109', 'Sacacorcho Zincado', 'Sacacorchos', 0, 12, true, '06c7c3f9-745a-4edf-942e-e217f3ba6b62'::uuid) on conflict (id) do nothing;
insert into public.loke_products (id, cod, description, category, list_price, uxb, active, equiv_product_id) values ('fb80410d-bd89-4162-b639-20b75524e8c2'::uuid, '110', 'Colador 8cm', 'Coladores', 540, 36, true, '9a4ba718-871c-44a9-8438-b35888da58a6'::uuid) on conflict (id) do nothing;
insert into public.loke_products (id, cod, description, category, list_price, uxb, active, equiv_product_id) values ('bf955391-b4fe-4e9b-b65f-59496b570b3c'::uuid, '111', 'Colador 10cm', 'Coladores', 705, 24, true, '16765fae-7777-4f76-bc65-25503c457f8e'::uuid) on conflict (id) do nothing;
insert into public.loke_products (id, cod, description, category, list_price, uxb, active, equiv_product_id) values ('2030a2af-fbc6-4296-8921-532b62392840'::uuid, '112', 'Colador 16cm', 'Coladores', 2410, 24, true, '16765fae-7777-4f76-bc65-25503c457f8e'::uuid) on conflict (id) do nothing;
insert into public.loke_products (id, cod, description, category, list_price, uxb, active, equiv_product_id) values ('886a7002-2f93-4244-8f8a-6d92a1548898'::uuid, '113', 'Colador 20cm', 'Coladores', 3430, 24, true, '912f596c-6abf-4177-ab45-5303947f7ecc'::uuid) on conflict (id) do nothing;
insert into public.loke_products (id, cod, description, category, list_price, uxb, active, equiv_product_id) values ('16b066dc-b656-49d3-9e29-db63f28800a5'::uuid, '114', 'Afila Cuchillos', 'Accesorios', 1465, 6, true, '1a93cae0-d63c-4437-b167-3a31d20a5deb'::uuid) on conflict (id) do nothing;
insert into public.loke_products (id, cod, description, category, list_price, uxb, active, equiv_product_id) values ('f5e016d5-52b9-4a61-af63-94eb314f7160'::uuid, '115', 'Batidor Pera', 'Utensilios', 995, 12, true, '6c010453-21de-40fb-ad00-46257f43d7b2'::uuid) on conflict (id) do nothing;
insert into public.loke_products (id, cod, description, category, list_price, uxb, active, equiv_product_id) values ('69b26ace-111d-47c1-b913-e9027c5e577b'::uuid, '116', 'Corta Pizza Familiar', 'Reposteria', 1200, 12, true, '10085c1e-e3a1-4dea-9be7-03bd14093f92'::uuid) on conflict (id) do nothing;
insert into public.loke_products (id, cod, description, category, list_price, uxb, active, equiv_product_id) values ('deb22d15-a7d6-478f-a39d-abf7c1340b3d'::uuid, '118', 'Corta Queso Mgo LK', 'Cortadores', 0, 12, true, 'c2ad99bd-9171-45b5-b83d-f1455331a67b'::uuid) on conflict (id) do nothing;
insert into public.loke_products (id, cod, description, category, list_price, uxb, active, equiv_product_id) values ('a20dc552-2056-4e1f-b168-8106400ffe83'::uuid, '119', 'Corta Queso Entero', 'Cortadores', 1450, 12, true, 'eefbd13a-8786-4128-b7d8-1f339d729243'::uuid) on conflict (id) do nothing;
insert into public.loke_products (id, cod, description, category, list_price, uxb, active, equiv_product_id) values ('98ca808e-5468-4ad1-b1c8-30d55d65b234'::uuid, '120', 'Filtro De Café', 'Accesorios', 0, 24, true, 'c7d60bc1-2d2b-431e-8ae1-316480d6a8a0'::uuid) on conflict (id) do nothing;
insert into public.loke_products (id, cod, description, category, list_price, uxb, active, equiv_product_id) values ('396e358a-e866-4e6e-b7da-8d29e8e06c91'::uuid, '121', 'Pisa Papas Inox.', 'Reposteria', 1420, 12, true, '4e81aea5-9665-4093-bcfb-88600afe7343'::uuid) on conflict (id) do nothing;
insert into public.loke_products (id, cod, description, category, list_price, uxb, active, equiv_product_id) values ('03545598-144f-4c2a-ad2e-d9c78883ea51'::uuid, '122', 'Rallador Cilíndrico', 'Utensilios', 0, 12, true, '091f0580-3b61-44bd-b24f-e57245fbe895'::uuid) on conflict (id) do nothing;
insert into public.loke_products (id, cod, description, category, list_price, uxb, active, equiv_product_id) values ('cd08851d-a636-405c-8070-a02f47ec0000'::uuid, '123', 'Pelador Mgo Plástico', 'Peladores', 790, 12, true, '7b0848ef-1ea5-4dba-b865-27d4a53a6b73'::uuid) on conflict (id) do nothing;
insert into public.loke_products (id, cod, description, category, list_price, uxb, active, equiv_product_id) values ('e8f236cb-f3a7-403f-b347-65243d5a56c4'::uuid, '186', 'Pelador Ergonómico', 'Peladores', 0, 12, true, '73e6d7e1-edbc-4a53-8387-d5230604a757'::uuid) on conflict (id) do nothing;
insert into public.loke_products (id, cod, description, category, list_price, uxb, active, equiv_product_id) values ('ea583eb3-7e9f-4ebb-a453-b9b4b035da58'::uuid, '193', 'Tostador Enlozado', 'Accesorios', 0, 12, true, null) on conflict (id) do nothing;

-- ALTA APLICADA (2026-09-11), pedido de Thomas:
-- insert into public.loke_products (cod, description, category, list_price, uxb, active)
-- values ('198E', 'Pelador Negro Dentado Loke', 'Peladores', 1110, 12, true);
--   id generado: 6a799882-4f97-4e27-9310-7c31ecfd80f5
--
-- Por que 1110: es el precio que ya tenia en item_precios (v_item_precio lo servia con
-- fuente 'item_precios:manual'), asi que el alta NO cambio ningun precio — solo movio la
-- fuente a loke_products. Coto sigue con su lista de super ($1.100) y La Anonima con la
-- suya ($1.110); Osa (2533) sigue con su precio pactado de $660 en GV_Precios_Cliente
-- (es_final), que le gana a la lista.
--
-- Medido: la OC de La Anonima 22908256, que entraba PARCIAL (13 de 14 renglones, total
-- $16.695.240 vs $17.627.640 del PDF), pasa a 'importada' con 14 de 14 y total EXACTO
-- ($17.627.640). Es el problema 26 de github_repo_problemas.
