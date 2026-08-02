'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   fm-data.js  —  leagues, clubs and squads for the Football Manager game
   ------------------------------------------------------------------------
   THIS FILE IS DATA ONLY. No discord.js, no game logic. Safe to edit by hand.

   Squad format is one compact string per club:
       "Name|POS|RATING, Name|POS|RATING, ..."
   POS is GK / DEF / MID / FWD. RATING is 60-95 and drives BOTH the player's
   transfer price and his effect in the match engine.

   Derived automatically, so you never hand-maintain them:
     • club price   → from the average rating of its 11 best players
     • club captain → the highest-rated player in the squad. He comes WITH the
                      club, is never separately purchasable, and never sellable.
     • club tier    → from price (used for AI difficulty)

   TO CORRECT A TRANSFER: move the "Name|POS|RATING" chunk from one club's
   string to another's. That is the whole edit. Nothing else needs touching.

   ⚠️ ACCURACY: squads reflect the 2025/26 season as known at the time of
   writing and WILL go stale. Ratings are judgement calls for game balance,
   not official ratings from any provider.
   ══════════════════════════════════════════════════════════════════════════ */

const LEAGUES = {
  ly:  { id:'ly',  name:'Libyan Premier League', short:'Libya',       emoji:'🇱🇾', order:0 },
  epl: { id:'epl', name:'Premier League',        short:'England',     emoji:'🏴󠁧󠁢󠁥󠁮󠁧󠁿', order:1 },
  lal: { id:'lal', name:'LaLiga',                short:'Spain',       emoji:'🇪🇸', order:2 },
  sea: { id:'sea', name:'Serie A',               short:'Italy',       emoji:'🇮🇹', order:3 },
  bun: { id:'bun', name:'Bundesliga',            short:'Germany',     emoji:'🇩🇪', order:4 },
  li1: { id:'li1', name:'Ligue 1',               short:'France',      emoji:'🇫🇷', order:5 },
};

/* Libyan club prices stay hand-set at their original values so existing save
   data and the "cheapest entry point" design are preserved. */
const LY_PRICE = {
  'ahli-tripoli':1200, 'ittihad-tripoli':1200, 'hilal-benghazi':800, 'ahli-benghazi':800,
  'nasr-benghazi':750, 'akhdar':500, 'madina':500, 'ittihad-misrata':480, 'swihli':480,
  'olympic-zawiya':280, 'tahaddi':260, 'abu-salim':260, 'khaleej-sirte':240, 'asaria':240,
  'shat':220,
};

/* ══════════════════════════════════════════════════════════════════════════
   ⚠️ LIBYAN PREMIER LEAGUE
   The club captains below are kept exactly as they were in the original
   football.js. The remaining squad members use the same invented-name
   convention as the old placeholder generator — they are NOT claims about
   real footballers, because current LPL squads can't be verified from here.
   Swap in real names whenever you like; the format is identical.
   ══════════════════════════════════════════════════════════════════════════ */
const RAW = [
['ly','ahli-tripoli',"Al-Ahli Tripoli",'AHL','Tripoli',['#D32F2F','#7f1d1d','#ffffff'],
  "Ahmed Krawa'a|FWD|84, Bashir Al-Zawi|GK|68, Marwan Al-Fitouri|DEF|69, Anas Al-Hasi|DEF|67, Tariq Al-Khoja|MID|70, Nabil Al-Areibi|MID|68, Ridwan Al-Mahdi|FWD|69"],
['ly','ittihad-tripoli',"Al-Ittihad Tripoli",'ITT','Tripoli',['#1f2937','#f8fafc','#ffffff'],
  "Muad Eisa|FWD|83, Salem Al-Trabelsi|GK|68, Idris Al-Obeidi|DEF|69, Hamza Ben Omar|DEF|67, Sufyan Al-Jilani|MID|70, Basem Al-Zintani|MID|68, Ziad Al-Hariri|FWD|68"],
['ly','hilal-benghazi',"Al-Hilal Benghazi",'HIL','Benghazi',['#1d4ed8','#bfdbfe','#ffffff'],
  "Sayfulnasr Jaddour|DEF|79, Munir Al-Barghathi|GK|66, Ayman Al-Werfalli|DEF|66, Fathi Al-Darsi|MID|68, Walid Al-Rayyani|MID|67, Adel Al-Fakhri|FWD|67"],
['ly','ahli-benghazi',"Al-Ahli Benghazi",'AHB','Benghazi',['#b91c1c','#fecaca','#ffffff'],
  "Ismael Tajouri-Shradi|FWD|80, Bilal Al-Ferjani|GK|66, Karim Al-Suwaidi|DEF|67, Rami Bin Nasser|DEF|66, Yassin Al-Tuhami|MID|68, Osama Al-Ghariani|MID|67"],
['ly','nasr-benghazi',"Al-Nasr Benghazi",'NSR','Benghazi',['#f59e0b','#78350f','#1f2937'],
  "Muhanad Madyen|DEF|77, Saleh Al-Shibani|GK|65, Zaid Al-Nuwairi|DEF|66, Ashraf Al-Kabir|MID|67, Sami Al-Gheryani|MID|66, Jamal Al-Sanussi|FWD|67"],
['ly','akhdar',"Al-Akhdar",'AKH','Bayda',['#15803d','#bbf7d0','#ffffff'],
  "Abdallah Dagou|MID|74, Mustafa Al-Bakoush|GK|64, Hassan Al-Misrati|DEF|65, Tawfik Al-Sharif|DEF|64, Nasser Al-Hasi|MID|65, Khaled Al-Mabrouk|FWD|66"],
['ly','madina',"Al-Madina",'MDN','Tripoli',['#0ea5e9','#e0f2fe','#ffffff'],
  "Osamah Al Shuraimi|MID|73, Ibrahim Ben Ali|GK|64, Youssef Al-Zawi|DEF|65, Omar Al-Darsi|DEF|64, Faisal Al-Jilani|MID|65, Ali Al-Khoja|FWD|65"],
['ly','ittihad-misrata',"Al-Ittihad Misrata",'ITM','Misrata',['#047857','#a7f3d0','#ffffff'],
  "Mahmoud Al Shilw|MID|72, Hussein Al-Fitouri|GK|63, Bashir Al-Obeidi|DEF|64, Ali Al-Areibi|DEF|63, Sami Al-Mahdi|MID|65, Marwan Al-Trabelsi|FWD|65"],
['ly','swihli',"Al-Swihli",'SWH','Misrata',['#6d28d9','#ddd6fe','#ffffff'],
  "Marwan Mabrook|MID|72, Anas Al-Hariri|GK|63, Tariq Al-Rayyani|DEF|64, Bilal Al-Zintani|DEF|63, Zaid Al-Ferjani|MID|64, Adel Bin Nasser|FWD|65"],
['ly','olympic-zawiya',"Olympic Zawiya",'OLZ','Zawiya',['#ea580c','#ffedd5','#ffffff'],
  "Husain Taqtaq|FWD|68, Rami Al-Suwaidi|GK|62, Nabil Al-Werfalli|DEF|63, Munir Al-Kabir|DEF|62, Fathi Al-Nuwairi|MID|63"],
['ly','tahaddi',"Al-Tahaddi",'THD','Benghazi',['#1e3a8a','#dbeafe','#ffffff'],
  "Talal Farhat|DEF|67, Ziad Al-Gheryani|GK|62, Walid Al-Sanussi|DEF|62, Ayman Al-Bakoush|MID|63, Karim Al-Misrati|FWD|63"],
['ly','abu-salim',"Abu Salim",'ABS','Tripoli',['#831843','#fbcfe8','#ffffff'],
  "Faisal Al-Badri|MID|67, Yassin Al-Sharif|GK|62, Osama Al-Hasi|DEF|63, Basem Al-Mabrouk|DEF|62, Ridwan Ben Omar|FWD|63"],
['ly','khaleej-sirte',"Khaleej Sirte",'KHS','Sirte',['#0f766e','#ccfbf1','#ffffff'],
  "Moayad Al-Lafi|FWD|66, Salem Al-Tuhami|GK|61, Idris Al-Ghariani|DEF|62, Hamza Al-Shibani|DEF|61, Sufyan Al-Fakhri|MID|62"],
['ly','asaria',"Asaria",'ASR','Tripoli',['#525252','#e5e5e5','#ffffff'],
  "Badr Hassan|MID|65, Jamal Al-Zawi|GK|61, Saleh Al-Darsi|DEF|62, Mustafa Al-Jilani|DEF|61, Tawfik Al-Khoja|FWD|62"],
['ly','shat',"Al-Shat",'SHT','Tripoli',['#a16207','#fef3c7','#ffffff'],
  "Ahmed Huwaydi|DEF|65, Hassan Al-Obeidi|GK|61, Nasser Al-Areibi|DEF|61, Khaled Al-Mahdi|MID|62, Ibrahim Al-Trabelsi|FWD|62"],

/* ── Premier League ─────────────────────────────────────────────────────── */
['epl','liverpool',"Liverpool",'LIV','Liverpool',['#C8102E','#7f1d1d','#ffffff'],
  "Alisson|GK|88, Giorgi Mamardashvili|GK|82, Virgil van Dijk|DEF|89, Ibrahima Konate|DEF|84, Milos Kerkez|DEF|81, Jeremie Frimpong|DEF|82, Andrew Robertson|DEF|82, Conor Bradley|DEF|79, Ryan Gravenberch|MID|85, Alexis Mac Allister|MID|85, Dominik Szoboszlai|MID|84, Florian Wirtz|MID|87, Curtis Jones|MID|79, Mohamed Salah|FWD|89, Alexander Isak|FWD|87, Hugo Ekitike|FWD|83, Cody Gakpo|FWD|82"],
['epl','man-city',"Manchester City",'MCI','Manchester',['#6CABDD','#1C2C5B','#ffffff'],
  "Gianluigi Donnarumma|GK|88, James Trafford|GK|79, Ruben Dias|DEF|87, Josko Gvardiol|DEF|85, John Stones|DEF|82, Nathan Ake|DEF|82, Rayan Ait-Nouri|DEF|81, Matheus Nunes|DEF|79, Rodri|MID|90, Tijjani Reijnders|MID|85, Bernardo Silva|MID|85, Phil Foden|MID|86, Rayan Cherki|MID|82, Nico Gonzalez|MID|80, Erling Haaland|FWD|91, Omar Marmoush|FWD|84, Jeremy Doku|FWD|83, Savinho|FWD|82"],
['epl','arsenal',"Arsenal",'ARS','London',['#EF0107','#9C824A','#ffffff'],
  "David Raya|GK|85, William Saliba|DEF|87, Gabriel Magalhaes|DEF|86, Jurrien Timber|DEF|83, Ben White|DEF|82, Riccardo Calafiori|DEF|81, Cristhian Mosquera|DEF|79, Myles Lewis-Skelly|DEF|79, Declan Rice|MID|88, Martin Odegaard|MID|86, Martin Zubimendi|MID|85, Eberechi Eze|MID|84, Mikel Merino|MID|82, Bukayo Saka|FWD|87, Viktor Gyokeres|FWD|85, Gabriel Martinelli|FWD|82, Kai Havertz|FWD|82, Leandro Trossard|FWD|81, Noni Madueke|FWD|80"],
['epl','chelsea',"Chelsea",'CHE','London',['#034694','#DBA111','#ffffff'],
  "Robert Sanchez|GK|80, Filip Jorgensen|GK|77, Levi Colwill|DEF|82, Marc Cucurella|DEF|83, Reece James|DEF|83, Wesley Fofana|DEF|81, Malo Gusto|DEF|80, Jorrel Hato|DEF|80, Trevoh Chalobah|DEF|79, Moises Caicedo|MID|87, Cole Palmer|MID|86, Enzo Fernandez|MID|85, Romeo Lavia|MID|79, Joao Pedro|FWD|83, Alejandro Garnacho|FWD|81, Pedro Neto|FWD|81, Estevao|FWD|81, Liam Delap|FWD|79, Jamie Gittens|FWD|78"],
['epl','man-utd',"Manchester United",'MUN','Manchester',['#DA291C','#FBE122','#ffffff'],
  "Senne Lammens|GK|78, Altay Bayindir|GK|76, Matthijs de Ligt|DEF|83, Lisandro Martinez|DEF|83, Noussair Mazraoui|DEF|81, Leny Yoro|DEF|80, Diogo Dalot|DEF|80, Luke Shaw|DEF|79, Patrick Dorgu|DEF|77, Bruno Fernandes|MID|87, Casemiro|MID|80, Manuel Ugarte|MID|79, Kobbie Mainoo|MID|79, Mason Mount|MID|79, Matheus Cunha|FWD|84, Bryan Mbeumo|FWD|84, Amad Diallo|FWD|82, Benjamin Sesko|FWD|82"],
['epl','tottenham',"Tottenham Hotspur",'TOT','London',['#132257','#ffffff','#ffffff'],
  "Guglielmo Vicario|GK|83, Cristian Romero|DEF|86, Micky van de Ven|DEF|84, Pedro Porro|DEF|82, Destiny Udogie|DEF|80, Kevin Danso|DEF|78, Joao Palhinha|MID|83, Xavi Simons|MID|84, James Maddison|MID|82, Rodrigo Bentancur|MID|81, Pape Matar Sarr|MID|80, Lucas Bergvall|MID|79, Mohammed Kudus|FWD|83, Randal Kolo Muani|FWD|82, Dominic Solanke|FWD|81, Brennan Johnson|FWD|80, Richarlison|FWD|79"],
['epl','newcastle',"Newcastle United",'NEW','Newcastle',['#241F20','#f8fafc','#ffffff'],
  "Nick Pope|GK|80, Aaron Ramsdale|GK|78, Sven Botman|DEF|82, Malick Thiaw|DEF|81, Tino Livramento|DEF|80, Lewis Hall|DEF|80, Kieran Trippier|DEF|78, Dan Burn|DEF|78, Bruno Guimaraes|MID|86, Sandro Tonali|MID|85, Joelinton|MID|83, Jacob Ramsey|MID|79, Anthony Gordon|FWD|83, Nick Woltemade|FWD|82, Anthony Elanga|FWD|81, Yoane Wissa|FWD|81, Harvey Barnes|FWD|80"],
['epl','aston-villa',"Aston Villa",'AVL','Birmingham',['#670E36','#95BFE5','#ffffff'],
  "Emiliano Martinez|GK|85, Pau Torres|DEF|82, Ezri Konsa|DEF|81, Tyrone Mings|DEF|79, Lucas Digne|DEF|78, Matty Cash|DEF|78, Youri Tielemans|MID|84, Boubacar Kamara|MID|82, John McGinn|MID|81, Morgan Rogers|MID|83, Emiliano Buendia|MID|79, Ollie Watkins|FWD|84, Donyell Malen|FWD|79, Evann Guessand|FWD|78"],
['epl','brighton',"Brighton & Hove Albion",'BHA','Brighton',['#0057B8','#FFCD00','#ffffff'],
  "Bart Verbruggen|GK|80, Jan Paul van Hecke|DEF|80, Lewis Dunk|DEF|79, Maxim De Cuyper|DEF|78, Ferdi Kadioglu|DEF|78, Joel Veltman|DEF|76, Carlos Baleba|MID|82, Diego Gomez|MID|77, Yasin Ayari|MID|77, Jack Hinshelwood|MID|76, Kaoru Mitoma|FWD|83, Georginio Rutter|FWD|80, Yankuba Minteh|FWD|79, Danny Welbeck|FWD|78, Stefanos Tzimas|FWD|76"],
['epl','nottm-forest',"Nottingham Forest",'NFO','Nottingham',['#DD0000','#ffffff','#ffffff'],
  "Matz Sels|GK|80, Murillo|DEF|82, Nikola Milenkovic|DEF|82, Ola Aina|DEF|78, Neco Williams|DEF|77, Morato|DEF|76, Morgan Gibbs-White|MID|83, Elliot Anderson|MID|82, Douglas Luiz|MID|79, Ryan Yates|MID|76, Chris Wood|FWD|80, Dan Ndoye|FWD|80, Callum Hudson-Odoi|FWD|79, Omari Hutchinson|FWD|77, Igor Jesus|FWD|77"],
['epl','crystal-palace',"Crystal Palace",'CRY','London',['#1B458F','#C4122E','#ffffff'],
  "Dean Henderson|GK|81, Marc Guehi|DEF|84, Daniel Munoz|DEF|81, Maxence Lacroix|DEF|80, Chris Richards|DEF|79, Tyrick Mitchell|DEF|77, Adam Wharton|MID|81, Daichi Kamada|MID|79, Will Hughes|MID|75, Jean-Philippe Mateta|FWD|82, Ismaila Sarr|FWD|81, Yeremy Pino|FWD|79, Eddie Nketiah|FWD|77"],
['epl','west-ham',"West Ham United",'WHU','London',['#7A263A','#1BB1E7','#ffffff'],
  "Alphonse Areola|GK|79, Mads Hermansen|GK|78, Jean-Clair Todibo|DEF|80, Max Kilman|DEF|79, Konstantinos Mavropanos|DEF|78, Aaron Wan-Bissaka|DEF|78, El Hadji Malick Diouf|DEF|76, Lucas Paqueta|MID|83, Tomas Soucek|MID|80, James Ward-Prowse|MID|79, Mateus Fernandes|MID|77, Jarrod Bowen|FWD|84, Niclas Fullkrug|FWD|78, Crysencio Summerville|FWD|78, Callum Wilson|FWD|76"],
['epl','everton',"Everton",'EVE','Liverpool',['#003399','#ffffff','#ffffff'],
  "Jordan Pickford|GK|84, Jarrad Branthwaite|DEF|83, James Tarkowski|DEF|80, Vitaliy Mykolenko|DEF|77, Jake O'Brien|DEF|76, Michael Keane|DEF|75, Jack Grealish|MID|82, Idrissa Gueye|MID|78, Kiernan Dewsbury-Hall|MID|77, James Garner|MID|76, Iliman Ndiaye|FWD|81, Dwight McNeil|FWD|78, Beto|FWD|76, Thierno Barry|FWD|76"],
['epl','fulham',"Fulham",'FUL','London',['#ffffff','#000000','#000000'],
  "Bernd Leno|GK|81, Antonee Robinson|DEF|82, Calvin Bassey|DEF|80, Joachim Andersen|DEF|80, Kenny Tete|DEF|77, Alex Iwobi|MID|81, Sander Berge|MID|78, Emile Smith Rowe|MID|78, Sasa Lukic|MID|77, Harry Wilson|FWD|78, Raul Jimenez|FWD|78, Rodrigo Muniz|FWD|78, Adama Traore|FWD|78"],
['epl','brentford',"Brentford",'BRE','London',['#E30613','#ffffff','#ffffff'],
  "Caoimhin Kelleher|GK|79, Nathan Collins|DEF|81, Sepp van den Berg|DEF|78, Kristoffer Ajer|DEF|77, Michael Kayode|DEF|76, Rico Henry|DEF|76, Mikkel Damsgaard|MID|80, Vitaly Janelt|MID|77, Yehor Yarmoliuk|MID|76, Jordan Henderson|MID|76, Kevin Schade|FWD|79, Dango Ouattara|FWD|78, Igor Thiago|FWD|78, Fabio Carvalho|FWD|76"],
['epl','bournemouth',"AFC Bournemouth",'BOU','Bournemouth',['#DA291C','#000000','#ffffff'],
  "Djordje Petrovic|GK|80, Marcos Senesi|DEF|80, Bafode Diakite|DEF|79, Adrien Truffert|DEF|78, Alex Jimenez|DEF|76, James Hill|DEF|74, Tyler Adams|MID|79, Ryan Christie|MID|77, Marcus Tavernier|MID|77, Alex Scott|MID|76, Antoine Semenyo|FWD|83, Justin Kluivert|FWD|81, Evanilson|FWD|79, Eli Junior Kroupi|FWD|76"],
['epl','wolves',"Wolverhampton Wanderers",'WOL','Wolverhampton',['#FDB913','#231F20','#231F20'],
  "Jose Sa|GK|78, Sam Johnstone|GK|76, Emmanuel Agbadou|DEF|78, Toti Gomes|DEF|77, Yerson Mosquera|DEF|75, Hugo Bueno|DEF|74, Matt Doherty|DEF|74, Joao Gomes|MID|82, Andre|MID|79, Marshall Munetsi|MID|76, Jorgen Strand Larsen|FWD|80, Jhon Arias|FWD|79, Hwang Hee-chan|FWD|77, Tolu Arokodare|FWD|76"],
['epl','leeds',"Leeds United",'LEE','Leeds',['#ffffff','#1D428A','#1D428A'],
  "Lucas Perri|GK|78, Karl Darlow|GK|73, Jaka Bijol|DEF|78, Pascal Struijk|DEF|77, Joe Rodon|DEF|76, Gabriel Gudmundsson|DEF|76, Jayden Bogle|DEF|75, Ethan Ampadu|MID|79, Anton Stach|MID|78, Sean Longstaff|MID|76, Brenden Aaronson|MID|76, Ilia Gruev|MID|75, Daniel James|FWD|77, Noah Okafor|FWD|77, Dominic Calvert-Lewin|FWD|77, Lukas Nmecha|FWD|76"],
['epl','burnley',"Burnley",'BUR','Burnley',['#6C1D45','#99D6EA','#ffffff'],
  "Martin Dubravka|GK|78, Kyle Walker|DEF|80, Maxime Esteve|DEF|77, Quilindschy Hartman|DEF|74, Hjalmar Ekdal|DEF|73, Connor Roberts|DEF|73, Florentino Luis|MID|77, Josh Cullen|MID|76, Lesley Ugochukwu|MID|76, Jaidon Anthony|FWD|75, Zian Flemming|FWD|75, Lyle Foster|FWD|75, Loum Tchaouna|FWD|75, Armando Broja|FWD|75"],
['epl','sunderland',"Sunderland",'SUN','Sunderland',['#EB172B','#ffffff','#ffffff'],
  "Robin Roefs|GK|77, Anthony Patterson|GK|74, Nordi Mukiele|DEF|78, Omar Alderete|DEF|76, Dan Ballard|DEF|76, Reinildo Mandava|DEF|76, Trai Hume|DEF|75, Granit Xhaka|MID|83, Enzo Le Fee|MID|79, Habib Diarra|MID|78, Noah Sadiki|MID|77, Wilson Isidor|FWD|77, Brian Brobbey|FWD|77, Simon Adingra|FWD|77, Chemsdine Talbi|FWD|76"],
];

/* ── LaLiga ─────────────────────────────────────────────────────────────── */
RAW.push(
['lal','real-madrid',"Real Madrid",'RMA','Madrid',['#FEBE10','#00529F','#111827'],
  "Thibaut Courtois|GK|89, Andriy Lunin|GK|79, Eder Militao|DEF|84, Antonio Rudiger|DEF|84, Dean Huijsen|DEF|83, Alvaro Carreras|DEF|82, Trent Alexander-Arnold|DEF|85, David Alaba|DEF|80, Fran Garcia|DEF|77, Jude Bellingham|MID|89, Federico Valverde|MID|88, Aurelien Tchouameni|MID|85, Eduardo Camavinga|MID|84, Arda Guler|MID|83, Franco Mastantuono|MID|78, Kylian Mbappe|FWD|91, Vinicius Junior|FWD|89, Rodrygo|FWD|85, Brahim Diaz|FWD|82, Gonzalo Garcia|FWD|76"],
['lal','barcelona',"FC Barcelona",'BAR','Barcelona',['#A50044','#004D98','#ffffff'],
  "Joan Garcia|GK|84, Marc-Andre ter Stegen|GK|84, Wojciech Szczesny|GK|80, Pau Cubarsi|DEF|84, Ronald Araujo|DEF|84, Jules Kounde|DEF|85, Alejandro Balde|DEF|82, Andreas Christensen|DEF|80, Gerard Martin|DEF|76, Pedri|MID|88, Frenkie de Jong|MID|86, Dani Olmo|MID|85, Gavi|MID|83, Fermin Lopez|MID|83, Marc Casado|MID|78, Lamine Yamal|FWD|89, Raphinha|FWD|88, Robert Lewandowski|FWD|85, Ferran Torres|FWD|82, Marcus Rashford|FWD|82"],
['lal','atletico',"Atletico Madrid",'ATM','Madrid',['#CB3524','#262E62','#ffffff'],
  "Jan Oblak|GK|86, Robin Le Normand|DEF|83, Jose Maria Gimenez|DEF|83, Marcos Llorente|DEF|82, David Hancko|DEF|81, Clement Lenglet|DEF|79, Nahuel Molina|DEF|79, Matteo Ruggeri|DEF|78, Thiago Almada|MID|82, Pablo Barrios|MID|81, Koke|MID|80, Conor Gallagher|MID|79, Johnny Cardoso|MID|78, Julian Alvarez|FWD|87, Antoine Griezmann|FWD|85, Alexander Sorloth|FWD|82, Giuliano Simeone|FWD|80"],
['lal','athletic',"Athletic Club",'ATH','Bilbao',['#EE2523','#ffffff','#ffffff'],
  "Unai Simon|GK|84, Dani Vivian|DEF|81, Aitor Paredes|DEF|78, Yuri Berchiche|DEF|77, Andoni Gorosabel|DEF|76, Inigo Lekue|DEF|74, Oihan Sancet|MID|82, Mikel Jauregizar|MID|78, Mikel Vesga|MID|75, Nico Williams|FWD|85, Inaki Williams|FWD|80, Alex Berenguer|FWD|79, Gorka Guruzeta|FWD|77, Robert Navarro|FWD|75"],
['lal','villarreal',"Villarreal",'VIL','Villarreal',['#FFE667','#005187','#111827'],
  "Luiz Junior|GK|80, Juan Foyth|DEF|81, Renato Veiga|DEF|79, Rafa Marin|DEF|77, Sergi Cardona|DEF|77, Santiago Mourino|DEF|77, Dani Parejo|MID|82, Thomas Partey|MID|81, Alberto Moleiro|MID|79, Pape Gueye|MID|78, Pau Navarro|MID|75, Georges Mikautadze|FWD|80, Ayoze Perez|FWD|80, Gerard Moreno|FWD|80, Nicolas Pepe|FWD|78, Tani Oluwaseyi|FWD|75"],
['lal','betis',"Real Betis",'BET','Seville',['#00954C','#ffffff','#ffffff'],
  "Alvaro Valles|GK|79, Marc Bartra|DEF|77, Natan|DEF|77, Diego Llorente|DEF|77, Hector Bellerin|DEF|77, Junior Firpo|DEF|76, Isco|MID|82, Giovani Lo Celso|MID|81, Pablo Fornals|MID|79, Marc Roca|MID|78, Sergi Altimira|MID|76, Antony|FWD|83, Abde Ezzalzouli|FWD|80, Cucho Hernandez|FWD|78, Cedric Bakambu|FWD|75"],
['lal','real-sociedad',"Real Sociedad",'RSO','San Sebastian',['#0067B1','#ffffff','#ffffff'],
  "Alex Remiro|GK|83, Igor Zubeldia|DEF|80, Duje Caleta-Car|DEF|77, Sergio Gomez|DEF|77, Jon Aramburu|DEF|76, Aritz Elustondo|DEF|76, Brais Mendez|MID|82, Carlos Soler|MID|79, Benat Turrientes|MID|76, Pablo Marin|MID|75, Mikel Oyarzabal|FWD|85, Takefusa Kubo|FWD|84, Ander Barrenetxea|FWD|78, Orri Oskarsson|FWD|76"],
['lal','sevilla',"Sevilla",'SEV','Seville',['#D9042B','#ffffff','#ffffff'],
  "Orjan Nyland|GK|78, Cesar Azpilicueta|DEF|77, Marcao|DEF|76, Juanlu Sanchez|DEF|76, Kike Salas|DEF|75, Adria Pedrosa|DEF|74, Lucien Agoume|MID|77, Djibril Sow|MID|77, Nemanja Gudelj|MID|76, Batista Mendy|MID|75, Ruben Vargas|FWD|79, Alexis Sanchez|FWD|76, Isaac Romero|FWD|76, Akor Adams|FWD|75"],
['lal','valencia',"Valencia",'VAL','Valencia',['#FF6600','#000000','#ffffff'],
  "Julen Agirrezabala|GK|77, Mouctar Diakhaby|DEF|78, Jose Gaya|DEF|78, Cesar Tarrega|DEF|76, Copete|DEF|76, Dimitri Foulquier|DEF|75, Javi Guerra|MID|80, Pepelu|MID|78, Andre Almeida|MID|76, Hugo Duro|FWD|78, Diego Lopez|FWD|78, Arnaut Danjuma|FWD|77, Luis Rioja|FWD|76"],
['lal','celta',"Celta Vigo",'CEL','Vigo',['#8AC3EE','#ffffff','#111827'],
  "Ionut Radu|GK|77, Oscar Mingueza|DEF|79, Carl Starfelt|DEF|77, Marcos Alonso|DEF|76, Sergio Carreira|DEF|75, Javi Rodriguez|DEF|74, Fran Beltran|MID|77, Ilaix Moriba|MID|77, Hugo Alvarez|MID|76, Iago Aspas|FWD|80, Borja Iglesias|FWD|79, Pablo Duran|FWD|76, Williot Swedberg|FWD|75"],
['lal','rayo',"Rayo Vallecano",'RAY','Madrid',['#ffffff','#E53027','#E53027'],
  "Augusto Batalla|GK|78, Andrei Ratiu|DEF|78, Florian Lejeune|DEF|77, Abdul Mumin|DEF|76, Pep Chavarria|DEF|76, Pathe Ciss|MID|76, Oscar Valentin|MID|76, Unai Lopez|MID|76, Isi Palazon|FWD|80, Alvaro Garcia|FWD|78, Jorge de Frutos|FWD|78, Randy Nteka|FWD|74"],
['lal','osasuna',"Osasuna",'OSA','Pamplona',['#D91A21','#0A346F','#ffffff'],
  "Sergio Herrera|GK|77, Jesus Areso|DEF|77, Alejandro Catena|DEF|76, Juan Cruz|DEF|75, Valentin Rosier|DEF|75, Abel Bretones|DEF|74, Aimar Oroz|MID|79, Jon Moncayola|MID|78, Lucas Torro|MID|77, Ante Budimir|FWD|80, Ruben Garcia|FWD|76, Raul Garcia de Haro|FWD|74"],
['lal','mallorca',"RCD Mallorca",'MLL','Palma',['#E20613','#000000','#ffffff'],
  "Leo Roman|GK|77, Pablo Maffeo|DEF|78, Martin Valjent|DEF|77, Antonio Raillo|DEF|77, Marash Kumbulla|DEF|76, Johan Mojica|DEF|76, Sergi Darder|MID|79, Samu Costa|MID|78, Manu Morlanes|MID|75, Vedat Muriqi|FWD|80, Takuma Asano|FWD|75, Mateo Joseph|FWD|75, Jan Virgili|FWD|73"],
['lal','girona',"Girona",'GIR','Girona',['#CD2534','#ffffff','#ffffff'],
  "Paulo Gazzaniga|GK|78, Vitor Reis|DEF|77, Daley Blind|DEF|76, Arnau Martinez|DEF|76, David Lopez|DEF|75, Alejandro Frances|DEF|75, Azzedine Ounahi|MID|78, Ivan Martin|MID|76, Oriol Romeu|MID|76, Yaser Asprilla|MID|76, Vladyslav Vanat|FWD|77, Bryan Gil|FWD|77, Portu|FWD|76, Cristhian Stuani|FWD|76"],
['lal','getafe',"Getafe",'GET','Getafe',['#005999','#ffffff','#ffffff'],
  "David Soria|GK|79, Djene Dakonam|DEF|78, Domingos Duarte|DEF|76, Diego Rico|DEF|75, Juan Iglesias|DEF|75, Kiko Femenia|DEF|74, Luis Milla|MID|77, Mario Martin|MID|74, Alex Sola|MID|74, Borja Mayoral|FWD|79, Christantus Uche|FWD|76, Adrian Liso|FWD|73"],
['lal','espanyol',"RCD Espanyol",'ESP','Barcelona',['#007FC8','#ffffff','#ffffff'],
  "Marko Dmitrovic|GK|78, Leandro Cabrera|DEF|76, Fernando Calero|DEF|76, Carlos Romero|DEF|76, Omar El Hilali|DEF|76, Edu Exposito|MID|78, Urko Gonzalez|MID|75, Pol Lozano|MID|75, Javi Puado|FWD|80, Roberto Fernandez|FWD|76, Kike Garcia|FWD|75, Pere Milla|FWD|75"],
['lal','alaves',"Deportivo Alaves",'ALA','Vitoria-Gasteiz',['#0761AF','#ffffff','#ffffff'],
  "Antonio Sivera|GK|77, Jon Pacheco|DEF|75, Nahuel Tenaglia|DEF|75, Moussa Diarra|DEF|75, Victor Laguardia|DEF|75, Manu Sanchez|DEF|74, Carlos Vicente|MID|78, Antonio Blanco|MID|77, Denis Suarez|MID|76, Toni Martinez|FWD|77, Lucas Boye|FWD|76, Carlos Martin|FWD|74"],
['lal','levante',"Levante",'LEV','Valencia',['#005BAC','#B4082F','#ffffff'],
  "Mathew Ryan|GK|77, Unai Elgezabal|DEF|74, Matias Moreno|DEF|74, Jorge Cabello|DEF|72, Diego Pampin|DEF|72, Carlos Alvarez|MID|79, Unai Vencedor|MID|75, Adrian de la Fuente|MID|73, Etta Eyong|FWD|78, Ivan Romero|FWD|75, Goduine Koyalipou|FWD|73"],
['lal','elche',"Elche",'ELC','Elche',['#00913F','#ffffff','#ffffff'],
  "Inaki Pena|GK|78, Victor Chust|DEF|75, David Affengruber|DEF|75, Pedro Bigas|DEF|74, Alvaro Nunez|DEF|74, John Donald|DEF|72, Aleix Febas|MID|76, Marc Aguado|MID|74, Andre Silva|FWD|78, Rafa Mir|FWD|77, Grady Diangana|FWD|75, German Valera|FWD|73"],
['lal','oviedo',"Real Oviedo",'OVI','Oviedo',['#0B4EA2','#ffffff','#ffffff'],
  "Aaron Escandell|GK|74, David Costas|DEF|73, Dani Calvo|DEF|73, Nacho Vidal|DEF|73, Leander Dendoncker|MID|77, Santiago Colombatto|MID|74, Alberto Reina|MID|73, Ilyas Chaira|MID|74, Salomon Rondon|FWD|76, Josip Brekalo|FWD|76, Haissem Hassan|FWD|75"]
);

/* ── Serie A ────────────────────────────────────────────────────────────── */
RAW.push(
['sea','inter',"Inter",'INT','Milan',['#0068A8','#000000','#ffffff'],
  "Yann Sommer|GK|84, Josep Martinez|GK|77, Alessandro Bastoni|DEF|86, Federico Dimarco|DEF|85, Manuel Akanji|DEF|83, Denzel Dumfries|DEF|83, Francesco Acerbi|DEF|80, Stefan de Vrij|DEF|79, Carlos Augusto|DEF|78, Nicolo Barella|MID|86, Hakan Calhanoglu|MID|85, Piotr Zielinski|MID|81, Henrikh Mkhitaryan|MID|80, Davide Frattesi|MID|80, Petar Sucic|MID|78, Lautaro Martinez|FWD|87, Marcus Thuram|FWD|85, Ange-Yoan Bonny|FWD|78, Francesco Pio Esposito|FWD|76"],
['sea','napoli',"Napoli",'NAP','Naples',['#12A0D7','#003C82','#ffffff'],
  "Alex Meret|GK|82, Vanja Milinkovic-Savic|GK|80, Giovanni Di Lorenzo|DEF|83, Amir Rrahmani|DEF|82, Alessandro Buongiorno|DEF|82, Sam Beukema|DEF|80, Mathias Olivera|DEF|79, Leonardo Spinazzola|DEF|78, Juan Jesus|DEF|76, Kevin De Bruyne|MID|87, Scott McTominay|MID|85, Stanislav Lobotka|MID|84, Frank Anguissa|MID|84, Billy Gilmour|MID|79, Eljif Elmas|MID|78, Romelu Lukaku|FWD|83, David Neres|FWD|82, Matteo Politano|FWD|81, Rasmus Hojlund|FWD|80, Noa Lang|FWD|79, Lorenzo Lucca|FWD|77"],
['sea','milan',"AC Milan",'MIL','Milan',['#FB090B','#000000','#ffffff'],
  "Mike Maignan|GK|86, Fikayo Tomori|DEF|82, Strahinja Pavlovic|DEF|80, Pervis Estupinan|DEF|80, Matteo Gabbia|DEF|79, Alexis Saelemaekers|DEF|79, Koni De Winter|DEF|78, Luka Modric|MID|84, Adrien Rabiot|MID|84, Youssouf Fofana|MID|81, Samuele Ricci|MID|80, Ruben Loftus-Cheek|MID|79, Christian Pulisic|FWD|85, Rafael Leao|FWD|85, Christopher Nkunku|FWD|82, Santiago Gimenez|FWD|80"],
['sea','juventus',"Juventus",'JUV','Turin',['#000000','#ffffff','#ffffff'],
  "Michele Di Gregorio|GK|82, Gleison Bremer|DEF|85, Andrea Cambiaso|DEF|82, Federico Gatti|DEF|80, Pierre Kalulu|DEF|80, Lloyd Kelly|DEF|77, Juan Cabal|DEF|76, Khephren Thuram|MID|82, Manuel Locatelli|MID|81, Teun Koopmeiners|MID|81, Weston McKennie|MID|80, Kenan Yildiz|FWD|84, Jonathan David|FWD|83, Dusan Vlahovic|FWD|83, Francisco Conceicao|FWD|81, Lois Openda|FWD|81, Edon Zhegrova|FWD|78"],
['sea','atalanta',"Atalanta",'ATA','Bergamo',['#1D71B8','#000000','#ffffff'],
  "Marco Carnesecchi|GK|83, Isak Hien|DEF|82, Raoul Bellanova|DEF|81, Berat Djimsiti|DEF|79, Davide Zappacosta|DEF|79, Odilon Kossounou|DEF|78, Sead Kolasinac|DEF|78, Ederson|MID|84, Marten de Roon|MID|80, Mario Pasalic|MID|80, Ademola Lookman|FWD|85, Charles De Ketelaere|FWD|82, Gianluca Scamacca|FWD|80, Nikola Krstovic|FWD|79"],
['sea','roma',"AS Roma",'ROM','Rome',['#8E1F2F','#F0BC42','#ffffff'],
  "Mile Svilar|GK|84, Evan Ndicka|DEF|82, Angelino|DEF|81, Gianluca Mancini|DEF|80, Mario Hermoso|DEF|78, Wesley|DEF|78, Zeki Celik|DEF|76, Manu Kone|MID|83, Lorenzo Pellegrini|MID|80, Bryan Cristante|MID|79, Neil El Aynaoui|MID|77, Paulo Dybala|FWD|85, Matias Soule|FWD|80, Artem Dovbyk|FWD|79, Evan Ferguson|FWD|77, Stephan El Shaarawy|FWD|76"],
['sea','lazio',"Lazio",'LAZ','Rome',['#87D8F7','#000000','#111827'],
  "Ivan Provedel|GK|81, Alessio Romagnoli|DEF|80, Mario Gila|DEF|80, Nuno Tavares|DEF|78, Adam Marusic|DEF|77, Patric|DEF|76, Manuel Lazzari|DEF|76, Nicolo Rovella|MID|81, Matteo Guendouzi|MID|81, Danilo Cataldi|MID|77, Toma Basic|MID|74, Mattia Zaccagni|FWD|82, Boulaye Dia|FWD|79, Valentin Castellanos|FWD|79, Pedro|FWD|78, Gustav Isaksen|FWD|77"],
['sea','fiorentina',"Fiorentina",'FIO','Florence',['#592C82','#ffffff','#ffffff'],
  "David de Gea|GK|82, Pietro Comuzzo|DEF|79, Dodo|DEF|79, Robin Gosens|DEF|79, Luca Ranieri|DEF|77, Marin Pongracic|DEF|77, Nicolo Fagioli|MID|79, Rolando Mandragora|MID|78, Hans Nicolussi Caviglia|MID|76, Moise Kean|FWD|84, Albert Gudmundsson|FWD|81, Edin Dzeko|FWD|77, Roberto Piccoli|FWD|77"],
['sea','bologna',"Bologna",'BOL','Bologna',['#A81932','#1A2F5A','#ffffff'],
  "Lukasz Skorupski|GK|79, Jhon Lucumi|DEF|81, Emil Holm|DEF|76, Torbjorn Heggem|DEF|76, Martin Vitik|DEF|76, Charalampos Lykogiannis|DEF|75, Lewis Ferguson|MID|81, Remo Freuler|MID|80, Giovanni Fabbian|MID|77, Riccardo Orsolini|FWD|83, Santiago Castro|FWD|79, Ciro Immobile|FWD|77, Federico Bernardeschi|FWD|77, Nicolo Cambiaghi|FWD|77, Jonathan Rowe|FWD|76"],
['sea','torino',"Torino",'TOR','Turin',['#8B0000','#ffffff','#ffffff'],
  "Alberto Paleari|GK|75, Franco Israel|GK|75, Guillermo Maripan|DEF|78, Saul Coco|DEF|76, Valentino Lazaro|DEF|76, Adam Masina|DEF|75, Marcus Pedersen|DEF|75, Nikola Vlasic|MID|79, Cesare Casadei|MID|78, Gvidas Gineitis|MID|74, Che Adams|FWD|78, Giovanni Simeone|FWD|78, Duvan Zapata|FWD|77, Cyril Ngonge|FWD|77"],
['sea','udinese',"Udinese",'UDI','Udine',['#000000','#ffffff','#ffffff'],
  "Maduka Okoye|GK|77, Oumar Solet|DEF|79, Thomas Kristensen|DEF|76, Hassane Kamara|DEF|76, Christian Kabasele|DEF|75, Jesper Karlstrom|MID|76, Sandi Lovric|MID|77, Arthur Atta|MID|76, Nicolo Zaniolo|FWD|79, Keinan Davis|FWD|76, Vakoun Bayo|FWD|75, Iker Bravo|FWD|74"],
['sea','genoa',"Genoa",'GEN','Genoa',['#E63329','#0B2C5E','#ffffff'],
  "Nicola Leali|GK|76, Johan Vasquez|DEF|79, Alessandro Vogliacco|DEF|75, Aaron Martin|DEF|75, Brooke Norton-Cuffy|DEF|75, Stefano Sabelli|DEF|74, Morten Frendrup|MID|80, Ruslan Malinovskyi|MID|79, Milan Badelj|MID|74, Vitinha|FWD|76, Lorenzo Colombo|FWD|75, Jeff Ekhator|FWD|73"],
['sea','como',"Como",'COM','Como',['#003D7C','#ffffff','#ffffff'],
  "Jean Butez|GK|77, Alberto Dossena|DEF|76, Edoardo Goldaniga|DEF|75, Marc-Oliver Kempf|DEF|75, Alberto Moreno|DEF|75, Jacobo Ramon|DEF|75, Nico Paz|MID|83, Maximo Perrone|MID|78, Lucas Da Cunha|MID|76, Nicolas Kuhn|FWD|80, Alvaro Morata|FWD|79, Assane Diao|FWD|78, Anastasios Douvikas|FWD|76"],
['sea','cagliari',"Cagliari",'CAG','Cagliari',['#B41C2C','#00204E','#ffffff'],
  "Elia Caprile|GK|78, Yerry Mina|DEF|77, Sebastiano Luperto|DEF|76, Adam Obert|DEF|74, Gabriele Zappa|DEF|74, Marco Palestra|DEF|74, Gianluca Gaetano|MID|76, Matteo Prati|MID|75, Michel Adopo|MID|74, Andrea Belotti|FWD|77, Sebastiano Esposito|FWD|76, Semih Kilicsoy|FWD|74"],
['sea','verona',"Hellas Verona",'VER','Verona',['#FFDE00','#00205B','#111827'],
  "Lorenzo Montipo|GK|76, Armel Bella-Kotchap|DEF|76, Nicolas Valentini|DEF|74, Daniele Ghilardi|DEF|74, Domagoj Bradaric|DEF|74, Suat Serdar|MID|76, Antoine Bernede|MID|74, Gift Orban|FWD|77, Giovane|FWD|75, Amin Sarr|FWD|74"],
['sea','lecce',"Lecce",'LEC','Lecce',['#FFE500','#D50032','#111827'],
  "Wladimiro Falcone|GK|78, Kialonda Gaspar|DEF|74, Antonino Gallo|DEF|75, Danilo Veiga|DEF|73, Ylber Ramadani|MID|76, Balthazar Pierret|MID|73, Lameck Banda|FWD|75, Tete Morente|FWD|75, Santiago Pierotti|FWD|74, Nikola Stulic|FWD|73"],
['sea','parma',"Parma",'PAR','Parma',['#FFD700','#004B87','#111827'],
  "Zion Suzuki|GK|80, Alessandro Circati|DEF|76, Enrico Delprato|DEF|75, Lautaro Valenti|DEF|74, Emanuele Valeri|DEF|74, Adrian Bernabe|MID|78, Mandela Keita|MID|75, Patrick Cutrone|FWD|75, Mateo Pellegrino|FWD|75, Matija Frigan|FWD|74"],
['sea','sassuolo',"Sassuolo",'SAS','Sassuolo',['#00A752','#000000','#ffffff'],
  "Arijanet Muric|GK|77, Jay Idzes|DEF|77, Josh Doig|DEF|75, Tarik Muharemovic|DEF|74, Filippo Romagna|DEF|73, Kristian Thorstvedt|MID|76, Nemanja Matic|MID|76, Daniel Boloca|MID|75, Domenico Berardi|FWD|80, Andrea Pinamonti|FWD|78, Armand Lauriente|FWD|78"],
['sea','pisa',"Pisa",'PIS','Pisa',['#00337F','#ffffff','#ffffff'],
  "Adrian Semper|GK|74, Simone Canestrelli|DEF|74, Idrissa Toure|DEF|73, Antonio Caracciolo|DEF|72, Arturo Calabresi|DEF|72, Michel Aebischer|MID|76, Marius Marin|MID|74, M'Bala Nzola|FWD|76, Matteo Tramoni|FWD|75, Stefano Moreo|FWD|73, Henrik Meister|FWD|73"],
['sea','cremonese',"Cremonese",'CRE','Cremona',['#C8102E','#4B5563','#ffffff'],
  "Emil Audero|GK|76, Federico Baschirotto|DEF|75, Filippo Terracciano|DEF|74, Matteo Bianchetti|DEF|73, Giuseppe Pezzella|DEF|73, Warren Bondo|MID|75, Michele Collocolo|MID|74, Jamie Vardy|FWD|78, Federico Bonazzoli|FWD|75, Antonio Sanabria|FWD|75, Franco Vazquez|FWD|74"]
);

/* ── Bundesliga ─────────────────────────────────────────────────────────── */
RAW.push(
['bun','bayern',"Bayern Munich",'BAY','Munich',['#DC052D','#0066B2','#ffffff'],
  "Manuel Neuer|GK|85, Jonas Urbig|GK|76, Dayot Upamecano|DEF|85, Jonathan Tah|DEF|84, Alphonso Davies|DEF|84, Kim Min-jae|DEF|83, Konrad Laimer|DEF|80, Josip Stanisic|DEF|79, Sacha Boey|DEF|77, Joshua Kimmich|MID|87, Jamal Musiala|MID|87, Leon Goretzka|MID|82, Aleksandar Pavlovic|MID|81, Harry Kane|FWD|90, Michael Olise|FWD|87, Luis Diaz|FWD|85, Serge Gnabry|FWD|82, Nicolas Jackson|FWD|80"],
['bun','leverkusen',"Bayer Leverkusen",'B04','Leverkusen',['#E32221','#000000','#ffffff'],
  "Mark Flekken|GK|80, Alejandro Grimaldo|DEF|84, Edmond Tapsoba|DEF|82, Loic Bade|DEF|81, Jarell Quansah|DEF|80, Jeanuel Belocian|DEF|76, Malik Tillman|MID|81, Robert Andrich|MID|80, Aleix Garcia|MID|79, Ezequiel Fernandez|MID|78, Arthur|MID|76, Patrik Schick|FWD|83, Martin Terrier|FWD|80, Eliesse Ben Seghir|FWD|79, Jonas Hofmann|FWD|78, Christian Kofane|FWD|74"],
['bun','dortmund',"Borussia Dortmund",'BVB','Dortmund',['#FDE100','#000000','#111827'],
  "Gregor Kobel|GK|85, Nico Schlotterbeck|DEF|83, Waldemar Anton|DEF|80, Niklas Sule|DEF|79, Ramy Bensebaini|DEF|79, Julian Ryerson|DEF|79, Yan Couto|DEF|78, Daniel Svensson|DEF|76, Julian Brandt|MID|82, Pascal Gross|MID|81, Marcel Sabitzer|MID|80, Felix Nmecha|MID|79, Serhou Guirassy|FWD|86, Karim Adeyemi|FWD|81, Maximilian Beier|FWD|79, Fabio Silva|FWD|77"],
['bun','leipzig',"RB Leipzig",'RBL','Leipzig',['#DD0741','#001F47','#ffffff'],
  "Peter Gulacsi|GK|80, Castello Lukeba|DEF|82, David Raum|DEF|81, Willi Orban|DEF|80, Lutsharel Geertruida|DEF|79, Ridle Baku|DEF|78, Xaver Schlager|MID|80, Christoph Baumgartner|MID|80, Nicolas Seiwald|MID|79, Assan Ouedraogo|MID|77, Antonio Nusa|FWD|81, Romulo|FWD|77, Yan Diomande|FWD|76, Conrad Harder|FWD|76"],
['bun','frankfurt',"Eintracht Frankfurt",'SGE','Frankfurt',['#E1000F','#000000','#ffffff'],
  "Kaua Santos|GK|78, Michael Zetterer|GK|77, Robin Koch|DEF|81, Arthur Theate|DEF|79, Rasmus Kristensen|DEF|77, Nathaniel Brown|DEF|77, Aurelio Buta|DEF|75, Hugo Larsson|MID|80, Ellyes Skhiri|MID|79, Mario Gotze|MID|79, Can Uzun|MID|79, Ritsu Doan|FWD|80, Jonathan Burkardt|FWD|80, Ansgar Knauff|FWD|78, Jean-Matteo Bahoya|FWD|77"],
['bun','stuttgart',"VfB Stuttgart",'VFB','Stuttgart',['#E32219','#ffffff','#ffffff'],
  "Alexander Nubel|GK|82, Jeff Chabot|DEF|78, Maximilian Mittelstadt|DEF|79, Ramon Hendriks|DEF|76, Lorenz Assignon|DEF|76, Josha Vagnoman|DEF|75, Angelo Stiller|MID|83, Bilal El Khannouss|MID|79, Atakan Karazor|MID|77, Chema Andres|MID|75, Deniz Undav|FWD|84, Ermedin Demirovic|FWD|79, Jamie Leweling|FWD|78, Tiago Tomas|FWD|76"],
['bun','freiburg',"SC Freiburg",'SCF','Freiburg',['#000000','#E1000F','#ffffff'],
  "Noah Atubolu|GK|79, Matthias Ginter|DEF|78, Philipp Lienhart|DEF|77, Christian Gunter|DEF|77, Lukas Kubler|DEF|75, Jordy Makengo|DEF|75, Vincenzo Grifo|MID|79, Maximilian Eggestein|MID|77, Patrick Osterhage|MID|76, Igor Matanovic|FWD|76, Yuito Suzuki|FWD|76, Junior Adamu|FWD|75, Lucas Holer|FWD|75"],
['bun','hoffenheim',"TSG Hoffenheim",'TSG','Sinsheim',['#1961B5','#ffffff','#ffffff'],
  "Oliver Baumann|GK|80, Koki Machida|DEF|77, Albian Hajdari|DEF|75, Robin Hranac|DEF|75, Vladimir Coufal|DEF|75, Arthur Chaves|DEF|74, Grischa Promel|MID|78, Wouter Burger|MID|76, Umut Tohumcu|MID|75, Andrej Kramaric|FWD|79, Bazoumana Toure|FWD|76, Fisnik Asllani|FWD|76"],
['bun','mainz',"Mainz 05",'M05','Mainz',['#C3141E','#ffffff','#ffffff'],
  "Robin Zentner|GK|78, Anthony Caci|DEF|76, Silvan Widmer|DEF|75, Stefan Bell|DEF|74, Danny da Costa|DEF|74, Nadiem Amiri|MID|79, Paul Nebel|MID|77, Kaishu Sano|MID|77, Dominik Kohr|MID|76, Benedict Hollerbach|FWD|77, Armindo Sieb|FWD|76, Nelson Weiper|FWD|75"],
['bun','wolfsburg',"VfL Wolfsburg",'WOB','Wolfsburg',['#65B32E','#ffffff','#ffffff'],
  "Kamil Grabara|GK|79, Konstantinos Koulierakis|DEF|78, Joakim Maehle|DEF|77, Cedric Zesiger|DEF|75, Aaron Zehnter|DEF|74, Christian Eriksen|MID|79, Mattias Svanberg|MID|78, Yannick Gerhardt|MID|75, Mohammed Amoura|FWD|80, Jonas Wind|FWD|79, Dzenan Pejcinovic|FWD|74"],
['bun','bremen',"Werder Bremen",'SVW','Bremen',['#1D9053','#ffffff','#ffffff'],
  "Mio Backhaus|GK|76, Marco Friedl|DEF|78, Niklas Stark|DEF|76, Julian Malatini|DEF|74, Anthony Jung|DEF|74, Karim Coulibaly|DEF|73, Romano Schmid|MID|78, Jens Stage|MID|76, Senne Lynen|MID|76, Victor Boniface|FWD|80, Samuel Mbangula|FWD|77, Marco Grull|FWD|76, Justin Njinmah|FWD|75"],
['bun','union',"Union Berlin",'FCU','Berlin',['#EB1923','#D4AF37','#ffffff'],
  "Frederik Ronnow|GK|79, Diogo Leite|DEF|77, Danilho Doekhi|DEF|77, Josip Juranovic|DEF|76, Leopold Querfeld|DEF|75, Christopher Trimmel|DEF|74, Rani Khedira|MID|76, Janik Haberer|MID|76, Andras Schafer|MID|75, Andrej Ilic|FWD|76, Ilyas Ansah|FWD|75, Oliver Burke|FWD|75"],
['bun','gladbach',"Borussia Monchengladbach",'BMG','Monchengladbach',['#000000','#00A94E','#ffffff'],
  "Moritz Nicolas|GK|76, Ko Itakura|DEF|80, Nico Elvedi|DEF|78, Kevin Diks|DEF|77, Joe Scally|DEF|76, Lukas Ullrich|DEF|74, Rocco Reitz|MID|78, Julian Weigl|MID|78, Kevin Stoger|MID|77, Tim Kleindienst|FWD|79, Franck Honorat|FWD|78, Haris Tabakovic|FWD|76"],
['bun','augsburg',"FC Augsburg",'FCA','Augsburg',['#BA3733','#004B23','#ffffff'],
  "Finn Dahmen|GK|77, Mads Pedersen|DEF|76, Chrislain Matsima|DEF|75, Keven Schlotterbeck|DEF|74, Kristijan Jakic|MID|76, Arne Maier|MID|76, Elvis Rexhbecaj|MID|75, Mert Komur|MID|74, Alexis Claude-Maurice|FWD|78, Phillip Tietz|FWD|75, Samuel Essende|FWD|75"],
['bun','st-pauli',"FC St. Pauli",'STP','Hamburg',['#613915','#ffffff','#ffffff'],
  "Nikola Vasilj|GK|76, Hauke Wahl|DEF|75, Eric Smith|DEF|74, Karol Mets|DEF|74, Philipp Treu|DEF|73, Jackson Irvine|MID|77, Danel Sinani|MID|75, Morgan Guilavogui|FWD|75, Johannes Eggestein|FWD|75, Andreas Hountondji|FWD|74, Martijn Kaars|FWD|74"],
['bun','heidenheim',"1. FC Heidenheim",'FCH','Heidenheim',['#E30613','#0A2240','#ffffff'],
  "Diant Ramaj|GK|77, Patrick Mainka|DEF|74, Omar Traore|DEF|72, Jonas Fohrenbach|DEF|72, Paul Wanner|MID|79, Niklas Dorsch|MID|75, Adrian Beck|MID|74, Mathias Honsak|FWD|74, Budu Zivzivadze|FWD|74, Sirlord Conteh|FWD|73"],
['bun','hamburg',"Hamburger SV",'HSV','Hamburg',['#0A1E3C','#ffffff','#ffffff'],
  "Daniel Heuer Fernandes|GK|75, Luka Vuskovic|DEF|77, Miro Muheim|DEF|75, Dennis Hadzikadunic|DEF|74, Guilherme Ramos|DEF|74, William Mikelbrencis|DEF|73, Fabio Vieira|MID|78, Nicolas Capaldo|MID|76, Jean-Luc Dompe|FWD|77, Robert Glatzel|FWD|76, Rayan Philippe|FWD|76, Ransford Konigsdorffer|FWD|75"],
['bun','koln',"1. FC Koln",'KOE','Cologne',['#ED1C24','#ffffff','#ffffff'],
  "Marvin Schwabe|GK|76, Timo Hubers|DEF|75, Rav van den Berg|DEF|75, Joel Schmied|DEF|74, Dominique Heintz|DEF|73, Eric Martel|MID|76, Isak Johannesson|MID|76, Denis Huseinbasic|MID|75, Said El Mala|FWD|77, Ragnar Ache|FWD|76, Marius Bulter|FWD|76, Jan Thielmann|FWD|75"]
);

/* ── Ligue 1 ────────────────────────────────────────────────────────────── */
RAW.push(
['li1','psg',"Paris Saint-Germain",'PSG','Paris',['#004170','#DA291C','#ffffff'],
  "Lucas Chevalier|GK|83, Matvey Safonov|GK|79, Achraf Hakimi|DEF|87, Nuno Mendes|DEF|86, Willian Pacho|DEF|85, Marquinhos|DEF|84, Illia Zabarnyi|DEF|82, Lucas Beraldo|DEF|78, Vitinha|MID|88, Joao Neves|MID|85, Fabian Ruiz|MID|85, Warren Zaire-Emery|MID|81, Kang-in Lee|MID|80, Senny Mayulu|MID|77, Ousmane Dembele|FWD|89, Khvicha Kvaratskhelia|FWD|86, Desire Doue|FWD|85, Bradley Barcola|FWD|84, Goncalo Ramos|FWD|82"],
['li1','marseille',"Olympique Marseille",'OM','Marseille',['#2FAEE0','#ffffff','#ffffff'],
  "Geronimo Rulli|GK|82, Nayef Aguerd|DEF|80, Leonardo Balerdi|DEF|79, Facundo Medina|DEF|78, Timothy Weah|DEF|78, Emerson Palmieri|DEF|77, CJ Egan-Riley|DEF|76, Pierre-Emile Hojbjerg|MID|82, Matt O'Riley|MID|79, Geoffrey Kondogbia|MID|79, Angel Gomes|MID|78, Mason Greenwood|FWD|84, Igor Paixao|FWD|81, Amine Gouiri|FWD|80, Pierre-Emerick Aubameyang|FWD|80"],
['li1','monaco',"AS Monaco",'ASM','Monaco',['#CE1126','#ffffff','#ffffff'],
  "Lukas Hradecky|GK|80, Philipp Kohn|GK|77, Thilo Kehrer|DEF|80, Vanderson|DEF|79, Eric Dier|DEF|78, Mohammed Salisu|DEF|78, Jordan Teze|DEF|77, Caio Henrique|DEF|77, Denis Zakaria|MID|83, Aleksandr Golovin|MID|81, Lamine Camara|MID|78, Maghnes Akliouche|FWD|82, Mika Biereth|FWD|80, Folarin Balogun|FWD|79, Takumi Minamino|FWD|78, Ansu Fati|FWD|78"],
['li1','lille',"Lille OSC",'LIL','Lille',['#E01E13','#003DA5','#ffffff'],
  "Berke Ozer|GK|77, Alexsandro|DEF|80, Aissa Mandi|DEF|77, Calvin Verdonk|DEF|77, Nathan Ngoy|DEF|76, Tiago Santos|DEF|76, Benjamin Andre|MID|78, Ayyoub Bouaddi|MID|78, Ngal'ayel Mukau|MID|77, Hamza Igamane|FWD|78, Olivier Giroud|FWD|77, Matias Fernandez-Pardo|FWD|77, Felix Correia|FWD|76"],
['li1','nice',"OGC Nice",'NIC','Nice',['#E4022D','#000000','#ffffff'],
  "Marcin Bulka|GK|80, Jonathan Clauss|DEF|80, Melvin Bard|DEF|77, Moise Bombito|DEF|77, Dante|DEF|76, Antoine Mendy|DEF|75, Sofiane Diop|MID|79, Hicham Boudaoui|MID|77, Tom Louchet|MID|74, Terem Moffi|FWD|79, Jeremie Boga|FWD|78, Kevin Carlos|FWD|75"],
['li1','lyon',"Olympique Lyonnais",'OL','Lyon',['#ffffff','#DA291C','#1B458F'],
  "Dominik Greif|GK|79, Moussa Niakhate|DEF|79, Nicolas Tagliafico|DEF|79, Clinton Mata|DEF|78, Ainsley Maitland-Niles|DEF|77, Abner|DEF|76, Corentin Tolisso|MID|80, Tyler Morton|MID|78, Tanner Tessmann|MID|76, Malick Fofana|FWD|81, Pavel Sulc|FWD|78, Afonso Moreira|FWD|76, Martin Satriano|FWD|76"],
['li1','lens',"RC Lens",'RCL','Lens',['#FFE500','#D50032','#111827'],
  "Robin Risser|GK|76, Jonathan Gradit|DEF|77, Malang Sarr|DEF|76, Matthieu Udol|DEF|76, Ruben Aguilar|DEF|75, Jhoanner Chavez|DEF|75, Adrien Thomasson|MID|78, Florian Thauvin|FWD|80, Odsonne Edouard|FWD|77, Wesley Said|FWD|76, Rayan Fofana|FWD|74"],
['li1','strasbourg',"RC Strasbourg",'STR','Strasbourg',['#009EE0','#ffffff','#ffffff'],
  "Mike Penders|GK|76, Guela Doue|DEF|78, Valentin Barco|DEF|78, Ben Chilwell|DEF|78, Mamadou Sarr|DEF|76, Ismael Doukoure|DEF|76, Sebastian Nanasi|MID|77, Felix Lemarechal|MID|76, Emanuel Emegha|FWD|81, Dilane Bakwa|FWD|80, Joaquin Panichelli|FWD|78"],
['li1','brest',"Stade Brestois",'BRS','Brest',['#E30613','#ffffff','#ffffff'],
  "Marco Bizot|GK|79, Bradley Locko|DEF|77, Kenny Lala|DEF|75, Soumaila Coulibaly|DEF|75, Massadio Haidara|DEF|74, Mahdi Camara|MID|76, Romain Del Castillo|MID|77, Hugo Magnetti|MID|75, Ludovic Ajorque|FWD|78, Abdallah Sima|FWD|76, Kamory Doumbia|FWD|75"],
['li1','rennes',"Stade Rennais",'REN','Rennes',['#E23824','#000000','#ffffff'],
  "Brice Samba|GK|82, Jeremy Jacquet|DEF|76, Anthony Rouault|DEF|76, Quentin Merlin|DEF|76, Alidu Seidu|DEF|75, Valentin Rongier|MID|79, Ludovic Blas|MID|78, Djaoui Cisse|MID|75, Breel Embolo|FWD|79, Esteban Lepaul|FWD|77, Mousa Al-Tamari|FWD|77"],
['li1','toulouse',"Toulouse FC",'TFC','Toulouse',['#582C83','#ffffff','#ffffff'],
  "Guillaume Restes|GK|79, Charlie Cresswell|DEF|78, Rasmus Nicolaisen|DEF|75, Mark McKenzie|DEF|75, Kevin Keben|DEF|74, Djibril Sidibe|DEF|74, Cristian Casseres|MID|76, Alexis Vossah|MID|74, Aron Donnum|FWD|77, Yann Gboho|FWD|77, Frank Magri|FWD|76, Santiago Hidalgo|FWD|74"],
['li1','nantes',"FC Nantes",'NAN','Nantes',['#FFDD00','#008D36','#111827'],
  "Anthony Lopes|GK|77, Nicolas Cozza|DEF|75, Chidozie Awaziem|DEF|75, Jean-Charles Castelletto|DEF|75, Kelvin Amian|DEF|74, Tylel Tati|DEF|74, Francis Coquelin|MID|76, Johann Lepenant|MID|75, Louis Leroux|MID|74, Matthis Abline|FWD|78, Mostafa Mohamed|FWD|77, Herba Guirassy|FWD|74"],
['li1','auxerre',"AJ Auxerre",'AJA','Auxerre',['#ffffff','#003DA5','#003DA5'],
  "Donovan Leon|GK|75, Sinaly Diomande|DEF|75, Jubal|DEF|74, Gideon Mensah|DEF|74, Paul Joly|DEF|74, Elisha Owusu|MID|76, Marius Courcoul|MID|73, Lassine Sinayoko|FWD|77, Gaetan Perrin|FWD|76, Theo Bair|FWD|75"],
['li1','angers',"Angers SCO",'SCO','Angers',['#000000','#ffffff','#ffffff'],
  "Yahia Fofana|GK|77, Cedric Hountondji|DEF|74, Ibrahim Amadou|DEF|73, Himad Abdelli|MID|78, Jean-Eudes Aholou|MID|75, Marouan Azarkan|FWD|75, Jim Allevinah|FWD|74, Zinedine Ferhat|FWD|74, Sidiki Cherif|FWD|74"],
['li1','le-havre',"Le Havre AC",'HAC','Le Havre',['#6CACE4','#003DA5','#ffffff'],
  "Mory Diaw|GK|76, Arouna Sangante|DEF|75, Gautier Lloris|DEF|74, Simon Ebonog|DEF|73, Rassoul Ndiaye|MID|75, Yassine Kechta|MID|75, Antoine Joujou|MID|74, Issa Soumare|FWD|74, Felix Mambimbi|FWD|74, Godson Kyeremeh|FWD|74"],
['li1','metz',"FC Metz",'FCM','Metz',['#7E0018','#ffffff','#ffffff'],
  "Jonathan Fischer|GK|74, Koffi Kouao|DEF|73, Sadibou Sane|DEF|73, Gauthier Hein|MID|75, Joseph N'Duquidi|MID|73, Boubacar Traore|MID|74, Habib Diallo|FWD|77, Cheikh Sabaly|FWD|74"],
['li1','paris-fc',"Paris FC",'PFC','Paris',['#003DA5','#ffffff','#ffffff'],
  "Obed Nkambadio|GK|75, Otavio|DEF|75, Thibault De Smet|DEF|74, Maxime Lopez|MID|77, Ilan Kebbal|MID|77, Vincent Marchetti|MID|74, Adama Camara|MID|74, Moses Simon|FWD|78, Jean-Philippe Krasso|FWD|76, Willem Geubbels|FWD|76"],
['li1','lorient',"FC Lorient",'FCL','Lorient',['#F58220','#000000','#ffffff'],
  "Yvon Mvogo|GK|77, Montassar Talbi|DEF|76, Isaak Toure|DEF|75, Bamo Meite|DEF|74, Igor Silva|DEF|73, Laurent Abergel|MID|76, Theo Le Bris|MID|75, Arsene Kouassi|MID|74, Aiyegun Tosin|FWD|76, Pablo Pagis|FWD|74"]
);

/* ══════════════════════════════════════════════════════════════════════════
   BUILD  —  everything below is derived. Don't hand-edit; edit RAW instead.
   ══════════════════════════════════════════════════════════════════════════ */
const slug = (s) => s.toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const round50 = (n) => Math.round(n / 50) * 50;

// Club value from the 11 best players. Tuned so the weakest European side
// costs more than the strongest Libyan one, and the elite are a long chase.
function priceFromSquad(players) {
  const top = players.slice().sort((a, b) => b.rating - a.rating).slice(0, 11);
  const avg = top.reduce((s, p) => s + p.rating, 0) / (top.length || 1);
  return clamp(round50(120 * Math.pow(1.235, avg - 62)), 1500, 25000);
}
const tierFromPrice = (p) => p >= 8000 ? 1 : p >= 4000 ? 2 : p >= 1500 ? 3 : p >= 700 ? 4 : 5;

const seen = new Map();          // playerId -> clubId (enforces one-of-one)
const dupes = [];
const CLUBS = [];
const PLAYERS = [];

for (const [league, id, name, short, city, colours, squadStr] of RAW) {
  const players = [];
  for (const chunk of squadStr.split(',')) {
    const bits = chunk.trim().split('|');
    if (bits.length !== 3) continue;
    const pname = bits[0].trim(), pos = bits[1].trim(), rating = parseInt(bits[2], 10);
    if (!pname || !['GK', 'DEF', 'MID', 'FWD'].includes(pos) || !Number.isFinite(rating)) continue;
    let pid = slug(pname);
    if (seen.has(pid)) {
      // Two different footballers can share a name (e.g. Vitinha at PSG and at
      // Genoa). Suffix the club so both exist rather than silently dropping one.
      dupes.push(`${pname}: ${seen.get(pid)} + ${id}`);
      pid = `${pid}--${id}`;
      if (seen.has(pid)) continue;               // same name twice at one club = real typo
    }
    seen.set(pid, id);
    players.push({ id: pid, name: pname, pos, rating, clubId: id, league });
  }
  players.sort((a, b) => b.rating - a.rating);
  const captainId = players.length ? players[0].id : null;
  if (players[0]) players[0].captain = true;

  const price = league === 'ly' ? (LY_PRICE[id] || 250) : priceFromSquad(players);
  const club = {
    id, name, short, city, league, price,
    tier: tierFromPrice(price),
    c: colours,
    captainId,
    // kept for backwards compatibility with the original CLUBS shape
    cap: players[0]
      ? { name: players[0].name, pos: players[0].pos, rating: players[0].rating, id: players[0].id }
      : { name: 'Unknown', pos: 'MID', rating: 60, id: null },
    squad: players,
  };
  CLUBS.push(club);
  PLAYERS.push(...players);
}

if (dupes.length) console.warn(`[fm-data] ${dupes.length} shared player name(s), disambiguated by club: ${dupes.slice(0, 8).join('; ')}`);

const CLUB_BY_ID = new Map(CLUBS.map(c => [c.id, c]));
const PLAYER_BY_ID = new Map(PLAYERS.map(p => [p.id, p]));

const clubById = (id) => CLUB_BY_ID.get(id) || null;
const playerById = (id) => PLAYER_BY_ID.get(id) || null;
const clubsInLeague = (lg) => CLUBS.filter(c => c.league === lg);
const leagueList = () => Object.values(LEAGUES).sort((a, b) => a.order - b.order);
// Everyone at a club except the captain — the captain is sold with the club.
const squadOf = (clubId) => (clubById(clubId) ? clubById(clubId).squad.filter(p => !p.captain) : []);

module.exports = {
  LEAGUES, CLUBS, PLAYERS,
  clubById, playerById, clubsInLeague, leagueList, squadOf,
  slug, priceFromSquad,
};
