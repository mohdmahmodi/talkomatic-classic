// server/games/words.js
// Word data for the games: DRAW, the drawable prompts for Draw and Guess,
// split by difficulty.

const DRAW_EASY = `
sun moon star cloud rain snow rainbow lightning
tree flower leaf grass bush cactus mushroom log
mountain hill river pond island beach volcano
house door window roof chimney fence gate stairs ladder
road bridge tunnel tent cave barn tower castle

car bus truck taxi van train plane boat bicycle scooter
rocket tractor ambulance helicopter submarine skateboard
traffic-light stop-sign wheel tire steering-wheel

cat dog fish bird duck chicken pig cow sheep horse
rabbit mouse frog turtle snake snail spider ant bee
butterfly ladybug crab shark whale dolphin octopus
lion tiger bear panda monkey elephant giraffe penguin
owl fox wolf deer camel zebra kangaroo dinosaur

apple banana orange lemon grape watermelon strawberry cherry
pear pineapple peach carrot potato tomato corn broccoli
pizza burger hot-dog taco sandwich bread cheese egg
cake cupcake donut cookie candy chocolate popcorn
ice-cream lollipop pancake waffle fries pretzel

cup mug glass bottle bowl plate spoon fork knife
pan pot kettle toaster fridge oven sink
table chair bed couch desk shelf bathtub toilet
lamp candle clock mirror rug pillow blanket
box bag basket bucket gift envelope key lock

shirt pants shorts dress skirt jacket coat
hat cap crown shoe boot sock glove scarf
belt tie glasses sunglasses watch ring necklace

ball balloon kite yo-yo dice card chess-piece
teddy-bear doll toy-car puzzle block
drum guitar piano bell whistle microphone

book pencil pen crayon marker brush paint
eraser ruler scissors glue paper notebook
hammer nail screw saw wrench screwdriver
magnet battery flashlight camera phone computer

heart arrow circle square triangle diamond
flag map coin trophy medal
eye ear nose mouth tooth hand foot
smile sad-face ghost robot alien monster
snowman angel pirate clown wizard
anchor bone feather shell paw-print
umbrella backpack suitcase mailbox
`;

const DRAW_MEDIUM = `
lighthouse windmill treehouse igloo cabin mansion
skyscraper church temple stadium museum library
hospital school factory fire-station police-station
gas-station grocery-store restaurant bakery
playground swimming-pool fountain wishing-well
waterfall canyon desert jungle swamp iceberg

fire-engine garbage-truck food-truck tow-truck
race-car police-car school-bus double-decker-bus
motorcycle dirt-bike unicycle roller-skates
sailboat canoe kayak yacht cruise-ship
fighter-jet hot-air-balloon parachute
forklift bulldozer excavator crane
snowmobile jet-ski spaceship satellite

alligator crocodile hippo rhino gorilla
chimpanzee orangutan koala sloth raccoon
squirrel hedgehog beaver skunk moose
reindeer polar-bear black-bear
peacock flamingo parrot toucan eagle
woodpecker pelican swan turkey rooster
ostrich bat vulture hummingbird
lobster jellyfish seahorse starfish
stingray swordfish pufferfish eel
seal walrus narwhal squid
chameleon iguana gecko salamander
scorpion centipede caterpillar grasshopper
dragonfly praying-mantis beetle mosquito

sunflower rose tulip daisy palm-tree
pine-tree bonsai-tree venus-flytrap
acorn pinecone coconut pumpkin
beehive birdhouse nest spiderweb

birthday-cake wedding-cake gingerbread-man
cotton-candy candy-cane fortune-cookie
spaghetti sushi burrito nachos
fried-chicken bacon sausage meatball
milkshake smoothie teapot coffee-pot

washing-machine dishwasher vacuum-cleaner
lawnmower wheelbarrow trampoline
shopping-cart baby-stroller rocking-chair
bunk-bed office-chair park-bench
ceiling-fan fireplace air-conditioner
alarm-clock hourglass compass thermometer
binoculars telescope microscope magnifying-glass

backpack handbag briefcase wallet
helmet cowboy-hat top-hat sombrero
high-heels slippers rain-boots
bow-tie headphones earmuffs

electric-guitar violin trumpet saxophone
accordion harp xylophone drum-kit
record-player music-note speaker

paint-palette paint-roller stapler hole-punch
calculator keyboard computer-mouse printer
video-camera security-camera remote-control
game-controller walkie-talkie

treasure-chest treasure-map pirate-ship
magic-wand crystal-ball spell-book
sword shield bow-and-arrow cannon
knight helmet armor catapult

campfire sleeping-bag picnic-basket
fishing-rod surfboard snowboard skis
baseball-bat baseball-glove basketball-hoop
football-goal hockey-stick bowling-ball
boxing-glove tennis-racket golf-club

traffic-cone parking-meter street-lamp
fire-hydrant manhole-cover road-sign
railroad-crossing bus-stop phone-booth

snow-globe jack-o-lantern christmas-tree
birthday-present party-hat party-balloon
easter-egg valentine-card
`;

const DRAW_HARD = `
roller-coaster ferris-wheel merry-go-round
water-slide bumper-car haunted-house
maze obstacle-course climbing-wall
bowling-alley movie-theater aquarium
greenhouse observatory planetarium
airport runway train-station subway-station
construction-site shipwreck

monster-truck cement-truck delivery-truck
armored-truck camper-van limousine
convertible race-car formula-one-car
steam-train bullet-train cable-car
airplane-cockpit pirate-ship submarine
spaceship lunar-rover space-shuttle
aircraft-carrier battleship

astronaut scuba-diver firefighter
police-officer construction-worker
chef baker waiter barber
doctor dentist scientist detective
farmer cowboy knight samurai
pirate captain magician juggler
tightrope-walker ballerina drummer
guitar-player skateboarder surfer
skiier snowboarder boxer wrestler
archer goalkeeper race-car-driver

dragon unicorn mermaid centaur
phoenix griffin cyclops minotaur
yeti bigfoot sea-monster
three-headed-dog winged-horse
robot-dog alien-robot space-alien
vampire mummy werewolf zombie
witch-on-a-broom ghost-in-a-sheet

fire-breathing-dragon sleeping-dragon
knight-with-shield pirate-with-parrot
wizard-with-wand astronaut-floating
diver-with-treasure cowboy-on-a-horse
chef-flipping-a-pancake magician-pulling-a-rabbit
clown-juggling-balls monkey-eating-a-banana
dog-catching-a-frisbee cat-climbing-a-tree
frog-catching-a-fly bird-building-a-nest
spider-spinning-a-web snake-in-a-basket
shark-chasing-a-fish octopus-holding-objects
penguin-on-an-iceberg bear-catching-a-fish

volcano-erupting tornado-touching-down
lightning-hitting-a-tree waterfall-with-rainbow
island-with-palm-tree mountain-with-waterfall
cave-with-stalactites iceberg-underwater
desert-with-cactus jungle-waterfall
lighthouse-on-a-cliff castle-on-a-hill
house-on-stilts treehouse-with-ladder
bridge-over-water tunnel-through-mountain

rocket-launch spaceship-landing
satellite-orbiting-earth astronaut-on-the-moon
alien-in-a-spaceship robot-on-a-skateboard
flying-saucer moon-rover solar-system
ringed-planet meteor-shower black-hole

treasure-chest-open treasure-map-with-x
ship-in-a-bottle message-in-a-bottle
sword-in-a-stone crown-on-a-pillow
castle-with-drawbridge pirate-flag
knight-on-a-horse dragon-egg
magic-potion magic-mirror crystal-ball
open-spell-book wizard-hat-with-stars

grand-piano pipe-organ double-bass
marching-drum french-horn bagpipes
dj-turntable karaoke-machine
microphone-on-a-stage concert-speakers

vending-machine arcade-machine pinball-machine
claw-machine slot-machine photo-booth
gumball-machine popcorn-machine
cash-register ATM-machine ticket-machine
elevator escalator revolving-door
shopping-cart-full-of-food

washing-machine-with-clothes vacuum-cleaner
sewing-machine typewriter grandfather-clock
cuckoo-clock rotary-phone film-projector
record-player jukebox old-camera
toolbox-full-of-tools swiss-army-knife
first-aid-kit fire-extinguisher

breakfast-plate picnic-table
birthday-table tea-party
stack-of-pancakes bowl-of-spaghetti
pizza-with-toppings hamburger-with-fries
ice-cream-sundae chocolate-fountain
gingerbread-house fruit-basket
roast-turkey sushi-platter

football-player-kicking basketball-player-dunking
baseball-player-batting tennis-player-serving
golfer-swinging hockey-goalie
boxer-punching weightlifter-lifting
skateboarder-jumping surfer-on-a-wave
skiier-going-downhill snowboarder-jumping
archer-shooting target-with-arrow

sandcastle-with-flag snowman-with-hat
kite-stuck-in-a-tree balloon-floating-away
umbrella-in-the-wind candle-blowing-out
melting-ice-cream broken-heart
bursting-balloon cracked-egg
open-gift-box overflowing-backpack

traffic-jam car-with-flat-tire
tow-truck-pulling-a-car train-crossing-a-bridge
plane-flying-over-clouds boat-in-big-waves
sailboat-in-the-wind helicopter-rescue
fire-truck-spraying-water ambulance-with-siren
tractor-pulling-a-trailer bulldozer-moving-dirt

camping-tent-with-fire picnic-under-a-tree
fisherman-catching-a-fish person-flying-a-kite
child-on-a-swing person-riding-a-bike
person-walking-a-dog person-reading-a-book
person-taking-a-photo person-painting-a-picture
person-opening-a-present person-building-a-snowman
`;

function split(text) {
  return text.trim().split(/\s+/).filter(Boolean);
}

const DRAW = {
  easy: split(DRAW_EASY),
  medium: split(DRAW_MEDIUM),
  hard: split(DRAW_HARD),
};

function prettyPrompt(word) {
  return String(word || "").replace(/-/g, " ");
}

module.exports = { DRAW, prettyPrompt };
