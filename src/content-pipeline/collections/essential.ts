import { CEFR_LEVELS } from '../../common/constants/domain';
import { CollectionSpec } from './collection.types';

const B2 = CEFR_LEVELS.indexOf('B2');
const CORE_RANK = 500;

// NGSL core words with a CEFR-J level up to B2: docs/content-sources.md §4.
export const ESSENTIAL: CollectionSpec = {
  slug: 'essential-english',
  title: 'Essential English',
  description: 'The 2,800 most useful words in everyday English, from A1 to B2.',
  color: '#2F80ED',
  promptVersion: 4,
  select: (entry) => entry.ngslRank !== null && CEFR_LEVELS.indexOf(entry.cefr) <= B2,
  maxLevel: 'B2',
  maxMeanings: (entry) => (entry.ngslRank !== null && entry.ngslRank <= CORE_RANK ? 5 : 3),
  examplesPerMeaning: 2,
  topics: [
    { slug: 'people-family', title: 'People & Family', description: 'Family members, friends and the people around you.', iosIcon: 'person.2.fill', covers: 'family, kinship, age groups, kinds of people, names for people by role in life' },
    { slug: 'relationships', title: 'Relationships & Social Life', description: 'Meeting, helping and getting along with others.', iosIcon: 'heart.circle.fill', covers: 'friendship, love, social events, helping, agreeing and arguing with people' },
    { slug: 'feelings-character', title: 'Feelings & Personality', description: 'Emotions, moods and what people are like.', iosIcon: 'face.smiling', covers: 'emotions, attitudes, personality traits, behaviour' },
    { slug: 'body-health', title: 'Body & Health', description: 'The body, illness, fitness and care.', iosIcon: 'heart.fill', covers: 'body parts, senses, illness, medicine, physical states, fitness' },
    { slug: 'home-daily-life', title: 'Home & Daily Routines', description: 'Rooms, furniture, chores and the day at home.', iosIcon: 'house.fill', covers: 'house, furniture, household objects, chores, sleeping, routines' },
    { slug: 'food-drink', title: 'Food & Drink', description: 'Meals, cooking, tastes and restaurants.', iosIcon: 'fork.knife', covers: 'food, drinks, cooking, eating out, tastes' },
    { slug: 'clothes-appearance', title: 'Clothes & Appearance', description: 'What people wear and how they look.', iosIcon: 'tshirt.fill', covers: 'clothing, accessories, looks, colours, fashion' },
    { slug: 'shopping-money', title: 'Shopping & Money', description: 'Buying, paying, prices and personal money.', iosIcon: 'cart.fill', covers: 'shops, buying and selling, prices, payment, personal finance' },
    { slug: 'work-jobs', title: 'Work & Jobs', description: 'Jobs, the workplace and careers.', iosIcon: 'briefcase.fill', covers: 'occupations, workplace, employment, tasks, careers' },
    { slug: 'business-economy', title: 'Business & Economy', description: 'Companies, trade, markets and the economy.', iosIcon: 'chart.line.uptrend.xyaxis', covers: 'companies, management, trade, industry, markets, the economy' },
    { slug: 'school-learning', title: 'School & Learning', description: 'Study, classes, exams and knowledge.', iosIcon: 'book.fill', covers: 'education, studying, subjects, exams, research' },
    { slug: 'communication', title: 'Talking & Communicating', description: 'Speaking, writing, asking and explaining.', iosIcon: 'bubble.left.and.bubble.right.fill', covers: 'speech acts, language, writing, messages, explaining, asking' },
    { slug: 'thinking-opinions', title: 'Thinking & Opinions', description: 'Ideas, beliefs, decisions and knowledge.', iosIcon: 'brain.head.profile', covers: 'mental acts, ideas, beliefs, opinions, decisions, memory, understanding' },
    { slug: 'travel-transport', title: 'Travel & Transport', description: 'Trips, vehicles, roads and holidays.', iosIcon: 'airplane', covers: 'travel, vehicles, roads, journeys, tourism, holidays' },
    { slug: 'places-buildings', title: 'Places & Buildings', description: 'Towns, cities, countries and buildings.', iosIcon: 'building.2.fill', covers: 'places, buildings, towns, countries, geography' },
    { slug: 'nature-weather', title: 'Nature, Animals & Weather', description: 'The natural world, animals, plants and weather.', iosIcon: 'leaf.fill', covers: 'nature, animals, plants, weather, environment, materials found in nature' },
    { slug: 'science-technology', title: 'Science & Technology', description: 'Computers, the internet, machines and science.', iosIcon: 'desktopcomputer', covers: 'science, technology, computers, internet, machines, energy' },
    { slug: 'media-arts', title: 'Media, Art & Entertainment', description: 'Music, films, books, news and art.', iosIcon: 'film.fill', covers: 'media, news, art, music, film, books, entertainment' },
    { slug: 'sports-free-time', title: 'Sports & Free Time', description: 'Games, sports, hobbies and having fun.', iosIcon: 'sportscourt.fill', covers: 'sports, games, hobbies, leisure, competition' },
    { slug: 'society-law', title: 'Society, Law & Government', description: 'Government, rules, crime and public life.', iosIcon: 'building.columns.fill', covers: 'politics, government, law, crime, war, religion, society, public services' },
    { slug: 'time-events', title: 'Time & Events', description: 'Days, dates, how often and when things happen.', iosIcon: 'clock.fill', covers: 'time, dates, frequency, sequence, events, occasions' },
    { slug: 'numbers-amounts', title: 'Numbers & Amounts', description: 'Quantities, measurements and comparisons.', iosIcon: 'number', covers: 'quantity, measurement, size of amounts, degree, comparison' },
    { slug: 'position-movement', title: 'Position & Movement', description: 'Where things are and how they move.', iosIcon: 'arrow.up.and.down.and.arrow.left.and.right', covers: 'location, direction, space, physical movement, carrying and holding' },
    { slug: 'describing-things', title: 'Describing Things', description: 'Size, shape, quality and other properties.', iosIcon: 'square.on.circle', covers: 'general qualities, size, shape, condition, difficulty, importance' },
    { slug: 'everyday-actions', title: 'Everyday Actions', description: 'Common verbs for doing, making and using things.', iosIcon: 'hand.raised.fill', covers: 'general-purpose actions: do, make, get, give, use, try, start, stop, change, cause' },
    { slug: 'linking-words', title: 'Linking & Function Words', description: 'Small words that connect ideas and sentences.', iosIcon: 'link', covers: 'pronouns, prepositions, conjunctions, discourse adverbs, words of degree or emphasis' },
  ],
};
