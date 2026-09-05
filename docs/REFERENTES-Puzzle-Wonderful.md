# Referentes: Puzzle y Wonderful — qué tomamos y qué no

> Análisis de dos empresas que ya resolvieron partes de lo que estamos diseñando, contrastado contra el
> PRD v1.1, el modelo de tenancy v1.4 y el estado real del código. Fecha: 2026-09-05.
> No es un resumen de sus productos: es una lista de decisiones.

## Por qué estas dos y no otras

Cubren las dos mitades de nuestro sistema, y ninguna cubre las dos.

**Puzzle** es el módulo de assessment convertido en producto. Mapea procesos, roles, herramientas y
datos como objetos conectados, con una IA que construye el mapa y un servidor MCP que se lo expone a
agentes externos.

**Wonderful** es el módulo de implementación y soporte convertido en producto. Despliega agentes que
resuelven flujos completos dentro de los sistemas reales de una empresa, con equipos humanos que hacen
la integración.

El hueco entre las dos es exactamente donde vive Sixteam: **nadie une el mapa con la ejecución**.
Puzzle documenta pero no implementa. Wonderful ejecuta pero no mapea la organización antes.

---

## Puzzle: la validación más fuerte que hemos tenido

Puzzle llegó de forma independiente a casi el mismo modelo de entidades que diseñamos. Eso no es
coincidencia, es que el problema tiene una forma correcta.

| Nuestro diseño | Su equivalente |
|---|---|
| Procesos con pasos, responsable y sistemas | Workflow Canvas |
| Roles, funciones y personas por rol | Team Designer |
| Inventario de herramientas del cliente y qué proceso soportan | Tool Canvas |
| Dónde vive cada dato y por qué pasos se mueve | Data Model |
| Agente que construye el grafo desde entrevistas | Nova AI |
| Agentes que leen y proponen cambios sobre el grafo | Puzzle MCP |
| Regla anti-pisado: el agente propone, el humano acepta | "Propone cambios de vuelta al blueprint para que un humano los revise" |
| El rol es la entidad, no la persona | "Construye tus procesos alrededor de roles, no de almas" |

Esa última línea merece atención. Es el mismo principio que fijamos, con el mismo argumento: los
procesos documentados sobre roles sobreviven a la rotación de personal. Verlo formulado por alguien que
lleva años en esto confirma la decisión.

### Ocho cosas que ellos tienen y nosotros no habíamos pensado

**1. Costeo por paso, con comparación entre el hoy y el propuesto.** Se costea el proceso como corre
hoy, se costea la versión propuesta, y la diferencia es la cifra de ahorro que se lleva al cliente,
junto con los pasos exactos de donde sale. **Lo adoptamos.** Es la pieza que le faltaba a nuestro
scoring de brechas: hoy puntuamos impacto y esfuerzo de forma abstracta, y esto lo convierte en
dinero. Además resuelve el problema comercial de justificar el proyecto ante el sponsor.

**2. Costo de herramienta atribuido a los procesos que la usan.** Saber cuánto cuesta al año cada
sistema y qué procesos dependen de él. **Lo adoptamos**, encaja directo en nuestro inventario de
sistemas y alimenta la decisión de comprar o construir.

**3. Una automatización externa es un paso, no un sub-mapa.** Cada flujo de n8n, HubSpot, Zapier o Make
entra como un solo paso con un enlace profundo a la herramienta, sin desglosar sus nodos internos.
**Lo adoptamos.** Es una decisión pragmática que nos ahorra un pozo sin fondo: intentar reflejar el
interior de cada automatización sería imposible de mantener sincronizado.

**4. Vistas compartibles por audiencia.** Agrupar partes del mapa para enseñárselas a alguien que solo
necesita ver esa parte. **Ya lo teníamos**, es nuestra publicación por fotografía y las cápsulas. La
diferencia es que ellos lo tratan como función central del producto y nosotros lo teníamos como
mecanismo técnico. Conviene subirlo de rango.

**5. Documentación sincronizada con varias versiones de un mismo proceso según la audiencia.** Sin
duplicar el trabajo. **Lo adaptamos**: encaja con nuestra distinción entre lo que ve Sixteam y lo que
ve el cliente, y evita mantener dos textos del mismo proceso.

**6. Coloreado condicional por reglas.** Reglas que pintan el diagrama solo para detectar de un vistazo
qué está en borrador, qué está automatizado o qué depende de cierta herramienta. **Lo adoptamos con
cuidado**, porque choca con la gramática de color que acabamos de fijar en el plan de experiencia. La
forma correcta es que sea una capa que se enciende, no el color por defecto del diagrama.

**7. Registro de cambios de cada decisión sobre el mapa.** **Ya lo tenemos** en la auditoría, pero no
está expuesto como una historia legible del blueprint. Vale la pena mostrarlo.

**8. Biblioteca de componentes por departamento.** Plantillas de procesos listas para partir de ahí.
**Lo adoptamos**, y encaja con nuestros templates de implementación, que hoy solo cubrían la fase de
construir y deberían cubrir también la de entender.

### La pregunta incómoda: usar Puzzle en vez de construirlo

Hay que hacerse la pregunta, porque el plan gratuito incluye todas las funciones, tiene MCP y
resolvería de golpe el visualizador que hoy no existe.

**Mi recomendación es no adoptarlo como pieza del producto, y sí evaluarlo como herramienta de trabajo
interno.**

La razón es de fondo. Nuestro principio dice que el activo es el contexto de cada empresa y la
metodología codificada. El grafo del cliente **es** ese activo. Ponerlo en un tercero significa que el
corazón del producto vive fuera, sujeto a su precio, su ritmo y su continuidad, y que la costura entre
mapa y ejecución, que es justamente nuestro diferencial, queda partida por una API ajena.

Dicho eso, tres usos legítimos hoy: probarlo para robar aprendizajes de interacción antes de diseñar el
nuestro, usarlo en un engagement real como entregable mientras nuestro visualizador no existe, y
auditar con él automatizaciones ya montadas en clientes que corren sobre HubSpot y n8n.

---

## Wonderful: lo que nos falta en la segunda mitad

Wonderful juega en otra liga de capital, pero su modelo operativo es el de Sixteam: plataforma más
equipos humanos que hacen la integración de verdad. Lo llaman ingenieros desplegados al frente. Es
literalmente lo que hace Sixteam, y confirma que el modelo servicio más software no es una limitación
de tamaño sino una elección defendible.

### Qué valida de lo nuestro

La orquestación entre varios modelos sin casarse con ninguno es nuestro principio de portabilidad de
proveedor. La integración por API y MCP a los sistemas reales para que el agente actúe y no solo
converse es nuestro catálogo de plataformas. Y construir el agente una vez para desplegarlo en varios
canales conservando el contexto es lo que necesitamos para que el entrevistador funcione igual por chat
que por WhatsApp.

### Cuatro capacidades concretas donde nuestro PRD es vago

Nuestro módulo de soporte dice "agentes en loop de mejora y recomendación". Eso es un deseo, no una
especificación. Wonderful lo tiene desglosado en piezas que sí se pueden construir:

**Inteligencia de interacción.** Trazabilidad de qué se comunicó, qué acciones se ejecutaron, qué
habilidades se usaron y qué datos se tocaron en cada conversación. Nosotros tenemos esto para las
ejecuciones de agente pero no para las conversaciones con personas.

**Etiquetado automático.** Clasificar cada interacción por evento, intención y sentimiento, mezclando
reglas fijas con análisis del modelo. Es la materia prima sin la cual el loop de mejora no tiene de
dónde sacar patrones.

**Detección de problemas recurrentes.** Encontrar el patrón antes de que se convierta en un incidente.
Esto es lo que nuestro agente de mejora continua debería hacer, y no habíamos dicho cómo.

**Experimentos entre variantes de agente.** Probar dos versiones midiendo resultado antes de desplegar
la ganadora. **Encaja directamente con lo que ya existe**, porque los prompts ya están versionados y
son inmutables. Es de las cosas más baratas de añadir y no estaba en el PRD.

**Alertas de negocio por umbral.** Avisos cuando una métrica cruza un límite definido por el negocio,
no por el sistema.

### Un tipo de agente que nos falta

Wonderful distingue tres: los que atienden al cliente final, los que atienden a los empleados de la
empresa, y los de trastienda que concilian sistemas y completan procesos.

Nosotros teníamos el primero, como agente de soporte, y el tercero disperso entre los expertos. **Nos
falta el segundo**: el agente que atiende a la gente de la empresa cliente, responde sus dudas sobre
sus propios procesos y ejecuta acciones en sus sistemas. Es el uso más natural del 2brain que estamos
construyendo, y probablemente el que más se percibe como valor una vez terminada la implementación.

### Lo que no debemos copiar

No construir modelo propio, que ya lo teníamos claro. Y su modelo de precio por valor entregado en vez
de por asiento es correcto conceptualmente, pero exige medir el resultado con rigor antes de poder
cobrarlo así.

---

## Lo que ninguno de los dos hace

Puzzle termina donde empieza la ejecución: te da el mapa y el costo, pero nadie implementa. Wonderful
empieza donde ya sabes qué quieres: despliega agentes, pero no descubre cómo funciona tu empresa.

**El recorrido completo, de entrevistar a una persona hasta tener el proceso corriendo con agentes y
alguien vigilando que siga funcionando, no lo hace ninguno de los dos.** Ese es el diferencial y
conviene escribirlo así en el material comercial, porque es defendible y verificable.

Con una advertencia honesta: ellos hacen bien su mitad y nosotros todavía no hacemos ninguna de las
dos. La ventaja del recorrido completo solo existe si se completa.

---

## Cambios concretos al PRD

1. **Añadir costeo de proceso** como parte del mapeo: costo por paso, comparación entre el estado
   actual y el propuesto, y costo anual por herramienta atribuido a los procesos que la usan. Pasa a
   ser la salida principal del assessment junto al roadmap.
2. **Fijar que una automatización externa es un paso con enlace**, nunca un sub-mapa.
3. **Subir las vistas por audiencia a función de producto**, no dejarlas como mecanismo interno.
4. **Añadir al módulo de soporte** las cuatro piezas concretas: trazabilidad de interacción, etiquetado
   automático, detección de patrones y alertas por umbral. Reemplazan la frase vaga sobre loops.
5. **Añadir experimentos entre variantes de agente**, apoyados en el versionado de prompts que ya
   existe.
6. **Añadir el agente para empleados del cliente** como tercer tipo, junto al de soporte y los expertos.
7. **Extender los templates a la fase de entender**, con procesos de referencia por departamento.
8. **Exponer el registro de cambios del grafo** como historia legible, no solo como auditoría.
