# Dirección visual de AgentOS

> Cierra el plan v1.5 de experiencia con la capa que faltaba: cómo se ve y cómo se siente.
> Dos referencias elegidas por Ernesto el 2026-09-05: el producto de Puzzle y el skill de interfaces
> fluidas de Apple recopilado por Emil Kowalski.
> Prototipo navegable: https://claude.ai/code/artifact/8c588f25-07ab-4df1-8f60-30309312d35e

## Qué tomamos de cada referencia

**De Puzzle** tomamos la actitud, no la piel. Su acierto es que **cada objeto del lienzo es un dato con
atributos, no una figura dibujada**, y que el lienzo es el producto y no una pantalla más. Su paleta
lavanda y violeta no la copiamos: es su marca, y además nuestra gramática de color ya reserva el
violeta para un significado concreto.

**Del skill de interfaces fluidas** tomamos el sistema de movimiento y la disciplina tipográfica
completos, porque son especificaciones con números, no opiniones.

## Las diez reglas que adoptamos, con sus valores

**1. Responder al pulsar, no al soltar.** Todo control se hunde a `scale(0.97)` en 100 ms. La latencia
percibida es el primer factor de que algo se sienta muerto.

**2. Movimiento por muelles, no por duraciones.** Amortiguación 1.0 y respuesta 0.4 segundos como
opción por defecto, sin rebote. El rebote, con amortiguación 0.8, se reserva para lo que el usuario
lanza con el dedo.

**3. Todo es interrumpible.** Una animación en curso se puede agarrar y revertir, y siempre arranca del
valor que está en pantalla, nunca del destino.

**4. La velocidad se hereda.** Al soltar un arrastre, el muelle continúa exactamente a la velocidad que
llevaba el dedo.

**5. El momento se proyecta.** No se salta al punto donde se soltó, se calcula a dónde iba con la
fórmula de decaimiento exponencial y se ancla al punto más cercano de ese destino.

**6. Los bordes ceden, no golpean.** Resistencia progresiva con la fórmula de goma en lugar de un tope
seco.

**7. La cromática flota y el contenido pasa por debajo.** Barra superior translúcida con desenfoque y
saturación, y un degradado donde el contenido se encuentra con ella, en vez de una línea de un píxel.

**8. Tipografía del sistema, con espaciado por tamaño.** Los títulos grandes cierran letras, el texto de
lectura queda en cero y las etiquetas pequeñas abren. Un solo valor de espaciado para todos los tamaños
es el error clásico.

**9. Late el punto, nunca el contenedor.** Un agente trabajando se señala con un pulso de siete
píxeles. Hoy el enjambre hace latir el nodo entero y el texto vibra hasta ser ilegible.

**10. Movimiento reducido no significa sin respuesta.** Con la preferencia activada se cambia el
desplazamiento por un fundido corto y se quitan los rebotes, pero el estado sigue confirmándose.

## El sistema, en concreto

**Color.** La gramática que fijamos en el plan de experiencia queda intacta: ámbar es trabajo en curso,
violeta es que se espera una decisión humana, rojo es roto o vencido, verde es cerrado, azul es enlace.
Los neutros llevan un leve sesgo frío para que no lean como gris de plantilla. Nada de color por
categoría.

**Tipografía.** La del sistema operativo, que ya trae ajuste óptico y tablas de espaciado afinadas.
Cinco tamaños, jerarquía construida con peso y no solo con cuerpo, y nada por debajo de doce píxeles en
elementos que se pueden pulsar.

**Profundidad.** Tres niveles de sombra y tres radios. La sombra separa, no decora: se gasta en lo que
flota de verdad.

**Densidad.** Dos modos y ninguno intermedio. Operar, con filas compactas, para decisiones, tablero y
actividad. Explorar, con tarjetas y prosa, para la ruta y el contexto.

## Qué demuestra el prototipo

Son dos pantallas reales del plan v1.5, no una maqueta decorativa.

**Hoy** abre con la frase que importa, no con un panel vacío. Cada decisión dice qué desbloquea y quién
la valida, y lleva a la ruta del proyecto. El atraso usa un solo patrón en todo el producto.

**La ruta** convierte el panel de fase enterrado en el cuerpo de la pantalla. El ciclo es un carril que
se arrastra con seguimiento uno a uno, hereda la velocidad al soltar, proyecta el momento y ancla en la
fase más cercana, y cede en los bordes en lugar de golpear.

Y el gate es el detalle que resume la tesis. Hoy es un texto que dice "Gate 1 pendiente" junto a un
botón deshabilitado con la palabra próximamente. En el prototipo es un candado que se abre al pulsarlo,
cambia a verde con quién aprobó y desbloquea visiblemente la fase siguiente. **El sistema avanza porque
los candados se abren, y eso tiene que verse.**

## Lo que queda por decidir

El prototipo usa la tipografía del sistema, que es lo que recomienda la referencia. Si Sixteam quiere
una familia propia con más carácter de marca, es la única pieza de esta dirección que cambiaría, y
conviene decidirlo antes de empezar a construir.
