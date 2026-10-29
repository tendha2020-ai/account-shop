// ideas.js: the idea library for Animal Antics.
// Every list here is mixed at random, so each shuffle gives a different video idea.

const PET_CHOICES = [
  { key: "dog", label: "Dog", emoji: "🐶" },
  { key: "cat", label: "Cat", emoji: "🐱" },
  { key: "monkey", label: "Monkey", emoji: "🐒" },
  { key: "bird", label: "Bird", emoji: "🐦" },
  { key: "bear", label: "Bear", emoji: "🐻" },
  { key: "goat", label: "Goat", emoji: "🐐" },
];

// Human things an animal can do anywhere, so they fit any clip or photo.
// p finishes the sentence "The dog ...".
const ACTIONS = [
  { t: "Hip-hop dancer", e: "🕺", p: "stands up on its hind legs like a human and dances hip-hop, bouncing to the beat, swinging its hips and waving its front paws in the air", c: ["When the beat drops 💀", "He's been practicing all week"] },
  { t: "Moonwalk", e: "🌙", p: "stands up on its hind legs and does a smooth Michael Jackson moonwalk backwards, then spins once", c: ["Smooth criminal 🕺", "Nobody taught him this"] },
  { t: "Walks like a boss", e: "😎", p: "stands up on its hind legs and walks forward on two legs like a human with a confident swagger, swinging its front paws", c: ["Main character energy", "Bro thinks he's human 😂"] },
  { t: "Gym workout", e: "💪", p: "stands up on its hind legs and does squats like at the gym, very focused, then flexes its front legs like a bodybuilder", c: ["Leg day 💪", "Summer body loading..."] },
  { t: "Judging you", e: "🤨", p: "stands up on its hind legs, puts its front paws on its hips and stares at the camera, slowly shaking its head in disappointment", c: ["When you come home late 🤨", "The disrespect..."] },
  { t: "Boxer", e: "🥊", p: "stands up on its hind legs like a boxer and throws fast punches at the air with its front paws, bouncing on its feet", c: ["Don't mess with him 🥊", "Rocky who?"] },
  { t: "Karate master", e: "🥋", p: "stands up on its hind legs and does karate moves, chopping the air with its front paws and doing a high kick", c: ["Black belt unlocked 🥋", "Hiyaaa!"] },
  { t: "Air guitar", e: "🎸", p: "stands up on its hind legs and plays a wild air guitar solo, headbanging with its eyes closed", c: ["Rock star mode 🎸", "The solo hit different"] },
  { t: "Phone call", e: "📱", p: "stands up on its hind legs, holds a smartphone to its ear with one paw and talks, waving the other paw around like it is arguing", c: ["\"I'll call you back\" 📱", "Talking to his lawyer"] },
  { t: "Floss dance", e: "🕹️", p: "stands up on its hind legs and does the floss dance, swinging its front paws side to side very fast", c: ["He learned it from Fortnite 💀", "Too good at this"] },
  { t: "Gasps and runs", e: "😱", p: "stands up on its hind legs, sees the camera, gasps with its mouth wide open and runs away on two legs like a human", c: ["Caught in 4K 😱", "He wasn't supposed to see that"] },
  { t: "Coffee break", e: "☕", p: "stands up on its hind legs holding a coffee mug in its front paws and takes a slow sip, then sighs like a tired office worker", c: ["Monday morning energy ☕", "Before coffee vs after"] },
  { t: "Yoga", e: "🧘", p: "stands up on one hind leg in a yoga tree pose with its front paws pressed together above its head, perfectly calm", c: ["Inner peace 🧘", "Namaste"] },
  { t: "Soldier march", e: "🫡", p: "stands up on its hind legs, salutes with one paw and marches on the spot like a soldier", c: ["Reporting for duty 🫡", "Sir yes sir"] },
  { t: "Twerk", e: "🍑", p: "stands up on its hind legs, turns around and twerks, shaking its back end to the beat", c: ["Not him twerking 💀", "Why is he so good at this"] },
  { t: "Ballet spin", e: "🩰", p: "stands up on the tips of its hind legs like a ballerina and spins gracefully with its front paws raised above its head", c: ["Swan lake 🩰", "Prima ballerina"] },
  { t: "Gentleman bow", e: "🎩", p: "stands up on its hind legs and bows politely like a gentleman, one paw on its chest and the other sweeping out to the side", c: ["Such a gentleman 🎩", "Good evening madam"] },
  { t: "Laughing at you", e: "🤣", p: "stands up on its hind legs, points one paw at the camera and laughs hysterically, holding its belly and bending over", c: ["He's laughing at me 🤣", "Me watching you fall"] },
  { t: "Goal celebration", e: "⚽", p: "stands up on its hind legs and celebrates like a footballer who just scored, running with its front paws spread wide, then slides on its knees", c: ["GOOOAL ⚽", "Ronaldo who?"] },
  { t: "Sneaky burglar", e: "🕵️", p: "stands up on its hind legs and tiptoes sneakily like a cartoon burglar, looking left and right", c: ["Sneaky mode activated 🕵️", "Where is he going?"] },
  { t: "Jumping jacks", e: "🏃", p: "stands up on its hind legs and does jumping jacks, clapping its front paws above its head", c: ["Morning workout 🏃", "Fitness influencer"] },
  { t: "Slip and fall", e: "🍌", p: "walks on its hind legs like a human, then slips and falls flat on its back with its legs in the air", c: ["Wait for it 😭", "He was doing so well"] },
  { t: "Sings into a mic", e: "🎤", p: "stands up on its hind legs holding a microphone and sings dramatically with its eyes closed, swaying side to side", c: ["Hit the high note 🎤", "Better than me honestly"] },
  { t: "Macarena", e: "💃", p: "stands up on its hind legs and does the Macarena dance, moving its front paws to its head and hips in order", c: ["Hey Macarena 💃", "He knows every move"] },
  { t: "Backflip", e: "🤸", p: "stands up on its hind legs, crouches and does a perfect backflip, then lands and throws its front paws up like a gymnast", c: ["10/10 landing 🤸", "Olympics next"] },
  { t: "Taxi!", e: "🚕", p: "stands up on its hind legs and waves both front paws high in the air like it is trying to stop a taxi", c: ["Late for work 🚕", "Taxiiiii!"] },
  { t: "Reads the news", e: "📰", p: "stands up on its hind legs holding a newspaper in its front paws, reads it, then lowers it and looks at the camera over the top", c: ["Did you see the news? 📰", "Grandpa vibes"] },
  { t: "Dab", e: "🫨", p: "stands up on its hind legs and does a dab, then a second dab the other way, very proud of itself", c: ["Dab on 'em 🫨", "Still in 2016"] },
  { t: "Slow clap", e: "👏", p: "stands up on its hind legs and gives a slow sarcastic clap with its front paws, staring at the camera", c: ["Wow. Great job. 👏", "Proud of you (not)"] },
  { t: "Impatient", e: "⌚", p: "stands up on its hind legs, crosses its front legs, taps one foot impatiently and looks at its wrist like checking a watch", c: ["You're late ⌚", "Waiting for my food like"] },
  { t: "Shy dance", e: "🙈", p: "stands up on its hind legs and does a little shy dance, covering its face with its front paws and wiggling", c: ["Don't look at me 🙈", "Shy but talented"] },
  { t: "Orchestra conductor", e: "🎻", p: "stands up on its hind legs and conducts an invisible orchestra, waving its front paws dramatically", c: ["Maestro 🎻", "And... FORTISSIMO"] },
  { t: "Morning jog", e: "👟", p: "jogs on its hind legs like a human doing a morning run, swinging its front paws", c: ["5am club 👟", "Running from my problems"] },
  { t: "Shrug and leave", e: "🤷", p: "stands up on its hind legs, shrugs its shoulders like 'okay...', then turns around and walks away on two legs", c: ["Okay...", "Not my problem 🤷"] },
  { t: "Runway model", e: "👠", p: "stands up on its hind legs and walks like a runway model, then stops, poses and turns around dramatically", c: ["Serving looks 👠", "Paris fashion week"] },
  { t: "Tantrum", e: "😤", p: "stands up on its hind legs and throws a tantrum, stomping its feet and waving its front paws angrily", c: ["When you say no treats 😤", "He wanted the other one"] },
  { t: "Tai chi", e: "☯️", p: "stands up on its hind legs and does slow tai chi moves with its front paws, completely calm", c: ["Zen master ☯️", "Calm before the zoomies"] },
  { t: "High five", e: "🙌", p: "stands up on its hind legs and gives an enthusiastic high five to someone off camera, then jumps with joy", c: ["Best friends 🙌", "Up top!"] },
  { t: "Chicken dance", e: "🐔", p: "stands up on its hind legs and does the chicken dance, flapping its front legs like wings", c: ["Wrong animal 🐔", "Identity crisis"] },
  { t: "Fist pump", e: "✊", p: "stands up on its hind legs and pumps its front paw in the air in celebration, shouting 'YES!'", c: ["When the food bowl is full ✊", "Let's gooo"] },
  { t: "Thinker", e: "🤔", p: "stands up on its hind legs and strokes its chin with one paw, deep in thought, then suddenly points up like it has an idea", c: ["Big brain time 🤔", "Planning something"] },
  { t: "Cha cha slide", e: "🪩", p: "stands up on its hind legs and does the cha cha slide, sliding to the left, then to the right, then stomping", c: ["Everybody clap your hands 🪩", "Party animal"] },
];

// Optional twist endings, the "wait for it" moment.
const TWISTS = [
  "At the end it loses its balance and falls flat on its back.",
  "Suddenly it notices the camera, freezes, and drops back down on all fours like nothing happened.",
  "At the end it trips over its own feet and tumbles over.",
  "Halfway through it stops, looks straight into the camera, then keeps going even harder.",
  "At the end it turns around and walks away on two legs like a boss.",
  "At the end another animal walks in and copies the exact same move.",
  "At the end it bumps into something and pretends it meant to do that.",
];

// Surprise mode: random animal, random place, random camera look.
const SURPRISE_ANIMALS = [
  "golden retriever", "chihuahua", "pug", "husky", "corgi", "french bulldog", "dachshund",
  "italian greyhound", "german shepherd", "orange tabby cat", "black and white tuxedo cat",
  "fluffy white cat", "grumpy grey cat", "macaque monkey", "baby hippo", "small crocodile",
  "giant panda", "brown bear", "polar bear", "capybara", "goat", "chicken", "penguin",
  "raccoon", "sloth", "goose", "kangaroo", "llama", "pig", "duck",
];

const OUTFITS = [
  "wearing a tiny backwards cap", "wearing sunglasses", "wearing a little hoodie",
  "wearing a tiny suit and tie", "wearing a gold chain", "wearing a bandana",
];

const STYLES = {
  phone: { t: "Phone video", img: "candid amateur smartphone photo, vertical, natural lighting, slightly imperfect framing", vid: "Realistic handheld smartphone video" },
  doorbell: { t: "Doorbell cam", img: "night-time doorbell security camera still, fisheye wide angle lens, slightly grainy, infrared-free colour night footage", vid: "Static doorbell security camera footage at night, fisheye lens" },
  sports: { t: "Sports broadcast", img: "TV sports broadcast frame, bright stadium lights, crowd in the background", vid: "TV sports broadcast footage" },
  cctv: { t: "CCTV", img: "high-angle CCTV security camera still, wide angle, slightly washed-out colours", vid: "Static high-angle CCTV security camera footage" },
};

// {a} is the animal. acts are moves that fit this place; otherwise a random ACTION is used.
const SCENES = [
  { s: "a {a} standing upright on its hind legs like a person on a busy street sidewalk in Vietnam, scooters parked nearby, shop signs", style: "phone" },
  { s: "three animals, a {a} and two friends, standing upright on their hind legs on a suburban front porch at night, seen from behind", style: "doorbell", acts: ["look around at each other, then all start dancing together in sync", "slowly turn around, see the camera and wave at it one by one"] },
  { s: "a {a} wearing a volleyball jersey with the number 7, standing upright among human players on the court in a professional volleyball arena", style: "sports", acts: ["jumps high and spikes the volleyball over the net, then screams and celebrates while its human teammates hug it"] },
  { s: "a {a} sitting in the driver's seat of a car, front paws on the steering wheel, seen from the passenger side", style: "phone", acts: ["drives the car, turning the steering wheel casually with one paw, then looks at the camera and honks the horn"] },
  { s: "a {a} standing upright at a kitchen stove wearing a chef hat, a frying pan in its paw", style: "phone", acts: ["flips a pancake in the frying pan like a professional chef, then tastes it and kisses its paw like 'perfect'"] },
  { s: "a {a} standing upright in a gym next to a barbell on the floor", style: "phone", acts: ["picks up the heavy barbell, lifts it over its head and roars, then drops it"] },
  { s: "a {a} standing upright on its hind legs in a living room with a sofa and wooden floor", style: "phone" },
  { s: "a {a} sitting on a toilet in a bathroom reading a newspaper like a human", style: "phone", acts: ["turns the page of the newspaper, then slowly lowers it and glares at the camera, annoyed"] },
  { s: "a {a} standing upright on its hind legs on green grass in a sunny park", style: "phone" },
  { s: "a {a} riding a small motorbike on a quiet street, front paws on the handlebars", style: "phone", acts: ["rides the motorbike down the street wobbling, then crashes softly into a bush and climbs out embarrassed"] },
  { s: "a {a} sitting upright at an office desk wearing a tie, typing on a computer keyboard", style: "phone", acts: ["types furiously on the keyboard, then slams the desk with both paws in frustration"] },
  { s: "a {a} standing upright pushing a shopping cart in a supermarket aisle", style: "cctv", acts: ["pushes the shopping cart, grabs a bag of snacks from the shelf and sneakily hides it in the cart, looking around"] },
  { s: "a {a} wearing a tiny suit standing upright on a wedding dance floor, guests around", style: "phone", acts: ["breaks into wild dance moves on the dance floor while the wedding guests cheer and clap"] },
  { s: "a {a} wearing sunglasses standing upright on a sunny beach by the water", style: "phone", acts: ["struts along the shore like a supermodel, then stops and strikes a pose"] },
  { s: "a {a} standing upright against a living room wall holding a can of bug spray, a big spider on the wall", style: "phone", acts: ["sprays the spider, then panics and jumps back screaming when the spider moves"] },
  { s: "a {a} standing upright on a balcony at night, city lights and the Eiffel Tower behind it", style: "phone" },
  { s: "a {a} standing upright on its hind legs in a parking lot next to a car", style: "cctv" },
  { s: "a {a} standing upright behind the counter of a small fast food shop wearing a cap", style: "cctv", acts: ["takes an order, hands a burger over the counter and waves goodbye to the customer"] },
];

const GENERIC_CAPTIONS = [
  "Okay...", "Caught on camera 😭", "POV: you left the house for 5 minutes",
  "Not him doing this again 💀", "Bro thinks he's human 😂", "The confidence 😂",
  "He knew I was filming", "Nobody: ... My {a}:", "This is why I can't leave him alone",
];

const HASHTAGS = "#funnyanimals #animalsoftiktok #aivideo #funnyvideos #fyp #viral";

// Classic funny-video sounds to search for in TikTok's "Add sound".
const SOUND_IDEAS = [
  "Monkeys Spinning Monkeys", "Sneaky Snitch", "Oh No (Kreepa)", "Funkytown",
  "Caramelldansen", "Fluffing a Duck", "Cha Cha Slide", "phonk remix",
];

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function shuffled(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function fillAnimal(text, animal) {
  return text.replace(/\{a\}/g, animal);
}

// Ideas for a picture or clip the user already has.
function ideasForPicture(animal, count = 4) {
  return shuffled(ACTIONS).slice(0, count).map((act) => ({
    title: act.t,
    emoji: act.e,
    action: act.p,
    twist: pick(TWISTS),
    caption: Math.random() < 0.75 ? pick(act.c) : fillAnimal(pick(GENERIC_CAPTIONS), animal),
    style: null,
  }));
}

// Ideas for a surprise scene: the scene's own moves first, then random ones.
function ideasForScene(scene, animal, count = 4) {
  const own = (scene.acts || []).map((p) => ({
    title: "Made for this scene", emoji: "⭐", action: p, caption: fillAnimal(pick(GENERIC_CAPTIONS), animal),
  }));
  const extra = shuffled(ACTIONS).slice(0, count - own.length).map((act) => ({
    title: act.t, emoji: act.e, action: act.p, caption: pick(act.c),
  }));
  return own.concat(extra).slice(0, count).map((idea) => ({
    ...idea, twist: pick(TWISTS), style: scene.style,
  }));
}

function randomScene() {
  const scene = pick(SCENES);
  const animal = pick(SURPRISE_ANIMALS);
  const style = STYLES[scene.style];
  const outfit = Math.random() < 0.4 ? ", " + pick(OUTFITS) : "";
  const subject = fillAnimal(scene.s, animal) + outfit;
  const prompt = `Photorealistic ${style.img}. ${subject}. Realistic fur, real animal anatomy and face, believable everyday footage, no text, no watermark.`;
  return { scene, animal, style, prompt };
}

// The text sent to the video model.
function videoPrompt(idea, animal, withTwist) {
  const look = idea.style ? STYLES[idea.style].vid : "Realistic video, same camera angle and same place as the picture";
  const twist = withTwist && idea.twist ? " " + idea.twist : "";
  return `${look}. The ${animal} ${idea.action}.${twist} Natural, physically believable movement, the ${animal} keeps exactly the same look, fur and face.`;
}
